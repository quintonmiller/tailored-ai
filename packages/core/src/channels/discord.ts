import { createHash } from "node:crypto";
import {
  type ChatInputCommandInteraction,
  Client,
  type Message as DiscordMessage,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { resolveAgent } from "../agent/agents.js";
import { compactSession, formatCompactResult } from "../agent/compact.js";
import { executeHooks } from "../agent/hooks.js";
import { estimateTokens, runAgentLoop } from "../agent/loop.js";
import { BASE_SYSTEM_PROMPT } from "../agent/prompt.js";
import { countTurns, rewindSession, undoRewind } from "../agent/rewind.js";
import { findOrCreateSession, resetSession } from "../agent/session.js";
import { executeCommand, isCommand } from "../commands.js";
import { loadAllContext, loadContextFiles } from "../context.js";
import { getSessionMessages } from "../db/queries.js";
import { createProjectTask, queryProjectTasks } from "../db/task-queries.js";
import type { ProjectRef } from "../projects/resolve.js";
import { IdentityResolver } from "../rooms/identities.js";
import { getRoomBackend, registerRoomBackend, unregisterRoomBackend } from "../rooms/registry.js";
import { formatRoomRef, type Room } from "../rooms/types.js";
import { makeRoomSessionKey } from "../rooms/watcher.js";
import type { AgentRuntime } from "../runtime.js";
import { DiscordApprovalHandler } from "./discord-approval.js";
import { getDiscordConfig } from "./discord-config.js";
import { buildRoomCommand, handleRoomAutocomplete, handleRoomCommand } from "./discord-room-commands.js";
import { DiscordRoomBackend } from "./discord-rooms.js";
import type { Channel } from "./interface.js";
import type { OutboundNotifier } from "./outbound.js";

const MAX_MESSAGE_LENGTH = 2000;

function splitMessage(text: string): string[] {
  if (text.length <= MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline
    let splitAt = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
    if (splitAt < MAX_MESSAGE_LENGTH / 2) {
      // No good newline, split at space
      splitAt = remaining.lastIndexOf(" ", MAX_MESSAGE_LENGTH);
    }
    if (splitAt < MAX_MESSAGE_LENGTH / 2) {
      // No good space either, hard split
      splitAt = MAX_MESSAGE_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks;
}

export interface DiscordChannelOptions {
  runtime: AgentRuntime;
}

export class DiscordChannel implements Channel, OutboundNotifier {
  /** Room capability, present only while the gateway is connected. */
  rooms: DiscordRoomBackend | undefined;
  /**
   * How `/room status` reaches the watcher. Set by the host once the watcher
   * exists; absent in embeds that run channels without one.
   */
  roomStatusRequester: ((room: Room, askedBy: string) => Promise<number>) | undefined;

  id = "discord";
  type = "discord";

  private client: Client;
  private runtime: AgentRuntime;
  private processing = new Set<string>();
  private userAgents = new Map<string, string>();
  private registeredCommandsHash = "";
  private disconnected = false;
  /** Serializes command syncs; concurrent overwrites registered everything twice. */
  private commandSync: Promise<void> = Promise.resolve();

  constructor(opts: DiscordChannelOptions) {
    this.runtime = opts.runtime;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });
  }

  async connect(): Promise<void> {
    const token = getDiscordConfig(this.runtime.getConfig())?.token;
    if (!token) {
      throw new Error("Discord token not configured");
    }

    this.client.on(Events.ClientReady, (c) => {
      console.log(`[discord] Logged in as ${c.user.tag}`);
      this.syncCommands().catch((err) => {
        console.error("[discord] Failed to sync application commands:", (err as Error).message);
      });
      // Rooms register only once the gateway is ready: listRooms reads the
      // guild channel cache, which is empty until then. Registering earlier
      // would make an agent's `room list` come back empty for no visible reason.
      this.registerRooms();
    });

    this.client.on(Events.MessageCreate, (msg) => this.handleMessage(msg));

    this.client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isAutocomplete()) {
        handleRoomAutocomplete(interaction, {
          store: this.runtime.getRoomStore(),
          identities: () => this.identities(),
          requestStatusUpdate: () => Promise.resolve(0),
          postAsPerson: () => Promise.resolve(),
          resetAgentSession: () => ({ cleared: 0, scope: "room" as const }),
          rewindAgentSession: async () => ({ scope: "room" as const, remaining: 0 }),
        });
        return;
      }
      if (!interaction.isChatInputCommand()) return;
      this.handleInteraction(interaction).catch((err) => {
        console.error("[discord] Interaction handler error:", (err as Error).message);
      });
    });

    // Error recovery: log errors and clean up stale state on reconnect
    this.client.on(Events.Error, (err) => {
      console.error("[discord] Client error:", err.message);
    });

    this.client.on(Events.ShardDisconnect, (event, shardId) => {
      console.warn(`[discord] Shard ${shardId} disconnected (code ${event.code}). Clearing stale state...`);
      this.processing.clear();
    });

    this.client.on(Events.ShardReconnecting, (shardId) => {
      console.log(`[discord] Shard ${shardId} reconnecting...`);
    });

    this.client.on(Events.ShardResume, (shardId, replayedEvents) => {
      console.log(`[discord] Shard ${shardId} resumed (replayed ${replayedEvents} events)`);
    });

    this.client.on(Events.ShardError, (err, shardId) => {
      console.error(`[discord] Shard ${shardId} error:`, err.message);
    });

    this.runtime.onReload(() => {
      this.syncCommands().catch((err) => {
        console.error("[discord] Failed to sync commands on reload:", (err as Error).message);
      });
    });

    await this.client.login(token);
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
    // Unregister before destroying the client: a room backend holding a dead
    // client would fail every call with a confusing discord.js error instead
    // of the registry's "no backend connected". Only drop the registry entry
    // if it is still ours — a newer connection may already have replaced it.
    if (this.rooms && getRoomBackend("discord") === this.rooms) {
      unregisterRoomBackend("discord");
    }
    this.rooms = undefined;
    this.client.destroy();
    console.log("[discord] Disconnected");
  }

  /**
   * Clear the conversation an agent is actually using for this room.
   *
   * Which session that is depends on the agent: `roomSessionScope: room` gives
   * it one memory per room, `shared` gives it a single memory spanning all of
   * them. Building the key without asking cleared the per-room session while
   * every agent here was running shared — so the command wiped an abandoned
   * session, reported the abandoned session's message count, and left the live
   * one untouched. It looked like it worked every time.
   *
   * Under `shared` there is no such thing as forgetting one room, so the caller
   * is told which happened and can say so rather than implying a precision the
   * storage model does not have.
   */
  private resetAgentSession(room: Room, agent: string): { cleared: number; scope: "room" | "shared" } {
    const resolved = resolveAgent(
      agent,
      this.runtime.getConfig(),
      this.runtime.getResolvableTools(),
      undefined,
      this.runtime.contextDir,
    );
    const scope = resolved.roomSessionScope;
    const key = makeRoomSessionKey(formatRoomRef(room.ref), agent, scope);
    const row = this.runtime.db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE key = ?)")
      .get(key) as { n: number } | undefined;

    resetSession(this.runtime.db, key, resolved.model, resolved.provider);
    return { cleared: row?.n ?? 0, scope };
  }

  /**
   * Take an agent's conversation back N turns, or restore the last rewind when
   * `turns` is 0.
   *
   * Shares `reset`'s session-key resolution, and therefore its caveat: an agent
   * on a `shared` scope has one conversation covering every room it is in, so
   * the scope comes back with the result and the caller says so.
   */
  private async rewindAgentSession(
    room: Room,
    agent: string,
    turns: number,
  ): Promise<{
    scope: "room" | "shared";
    rewound?: { turns: number; messages: number; excerpt: string };
    restored?: number;
    remaining: number;
  }> {
    const resolved = resolveAgent(
      agent,
      this.runtime.getConfig(),
      this.runtime.getResolvableTools(),
      undefined,
      this.runtime.contextDir,
    );
    const scope = resolved.roomSessionScope;
    const key = makeRoomSessionKey(formatRoomRef(room.ref), agent, scope);
    const db = this.runtime.db;

    const restored = turns === 0 ? (undoRewind(db, key)?.restored ?? 0) : undefined;
    const rewound = turns > 0 ? (rewindSession(db, key, turns) ?? undefined) : undefined;

    // Move the room cursor to now, or the watcher hands the conversation
    // straight back.
    //
    // A room's wake prompt is built from the BACKEND's messages, not from the
    // session — `fetchSince(roomId, sub.cursor)`. Rewinding only the session
    // therefore hid the exchange from the agent's memory and then re-fed it as
    // "New messages:" on the very next wake, agent's own last post included.
    // Observed: an agent quoted the message it had just been made to forget.
    //
    // Only this room's cursor moves. A shared-scope agent has one memory across
    // several rooms, but advancing all of them would silently drop genuinely
    // unread messages from rooms nobody asked about.
    if (turns > 0) {
      try {
        const backend = getRoomBackend(room.ref.backend);
        const latest = await backend?.fetchSince(room.ref.id, null, 1);
        const newest = latest?.[latest.length - 1]?.cursor;
        if (newest) this.runtime.getRoomStore().advanceCursor(agent, formatRoomRef(room.ref), newest);
      } catch (err) {
        // A cursor that could not be moved means the next wake replays the
        // rewound turn. Worth saying; not worth failing the rewind over.
        console.warn(`[rooms] rewind could not advance ${agent}'s cursor in "${room.name}": ${(err as Error).message}`);
      }
    }

    const sessionIds = (db.prepare("SELECT id FROM sessions WHERE key = ?").all(key) as { id: string }[]).map(
      (r) => r.id,
    );
    return {
      scope,
      rewound: rewound ? { turns: rewound.turns, messages: rewound.messages, excerpt: rewound.excerpt } : undefined,
      restored,
      remaining: countTurns(db, sessionIds),
    };
  }

  /**
   * Post into a room on a person's behalf.
   *
   * Posted through the room backend rather than plain `channel.send` so the
   * normal machinery applies: the agent is addressed properly, the watcher sees
   * a human turn (which resets the conversation-depth count), and the message
   * lands under the person's own name rather than the bot's.
   */
  private async postAsPerson(room: Room, speaker: string, to: string[], body: string): Promise<void> {
    const backend = this.rooms;
    if (!backend) throw new Error("Discord is not connected.");
    await backend.post(room.ref.id, { body, speaker, to });
  }

  /**
   * True when this Discord channel is a room somebody actually watches. A
   * registered-but-unsubscribed room still falls through to the normal mention
   * handler, so registering a room never silently makes the bot go quiet.
   */
  private isRoomChannel(channelId: string): boolean {
    try {
      // Gate on LIVE state, not just on rows in the database. With
      // `rooms.enabled: false` the subscription rows still exist but nothing
      // services them, and suppressing the mention path on their account
      // would make the bot go silent in that channel with no explanation.
      if (this.runtime.getConfig().rooms?.enabled === false) return false;
      if (!this.rooms) return false;

      const store = this.runtime.getRoomStore();
      const ref = `discord:${channelId}`;
      if (!store.getRoomByRef(ref)) return false;
      return store.listSubscriptionsForRoom(ref).length > 0;
    } catch {
      // Room bookkeeping must never swallow a normal Discord message.
      return false;
    }
  }

  /**
   * Expose this connection as a room backend. Identity awareness is threaded
   * in so a human typing "[note] ..." isn't parsed as a message from an agent
   * named `note`; the resolver is rebuilt per call to follow config reloads.
   */
  private registerRooms(): void {
    // A ClientReady queued on a client the lifecycle manager already tore down
    // would otherwise register a backend wrapping a destroyed connection.
    if (this.disconnected) return;

    const discordConfig = getDiscordConfig(this.runtime.getConfig());
    const backend = new DiscordRoomBackend(this.client, {
      guildId: discordConfig?.guildId,
      allowedGuilds: discordConfig?.allowedGuilds,
      isKnownIdentity: (label) => this.identities().isKnown(label),
      // Gives each agent its own name and picture in the channel, instead of a
      // "[speaker]" prefix on one shared bot account.
      store: this.runtime.getRoomStore(),
      avatarFor: (label) => this.identities().get(label)?.avatarUrl,
      // Lets "@quinton" go out as a real Discord mention that notifies, and
      // come back in resolvable to the identity rather than a bare snowflake.
      nativeIdFor: (label) => this.identities().get(label)?.nativeIds?.discord,
      labelForNativeId: (nativeId) => this.identities().byNativeId("discord", nativeId)?.label,
    });
    this.rooms = backend;
    registerRoomBackend(backend);
  }

  /**
   * Room identities as of right now. Rebuilt per call so a config reload takes
   * effect without a reconnect. An absent owner id is omitted rather than
   * registered as "" — an empty native id would make this resolver think
   * `owner` exists while the tool's resolver, which skips falsy ids, disagrees.
   */
  private identities(): IdentityResolver {
    const live = this.runtime.getConfig();
    const ownerId = this.runtime.getOwnerId("discord");
    return new IdentityResolver({
      agentNames: Object.keys(live.agents ?? {}),
      declared: live.rooms?.identities,
      ownerNativeIds: ownerId ? { discord: ownerId } : {},
      ownerLabel: live.rooms?.ownerLabel,
      defaultBackend: "discord",
    });
  }

  /**
   * Send the Discord "is typing…" indicator at `channelId` and keep it alive
   * by re-sending every 8 seconds (the API expires it on a ~10s window).
   * Returns a stop function that idempotently clears the keep-alive timer.
   * Channels without a `sendTyping` method (some thread/forum subtypes)
   * silently no-op.
   */
  indicateWorking(channelId: string): () => void {
    let timer: ReturnType<typeof setInterval> | undefined;
    let stopped = false;
    const send = async () => {
      try {
        const ch = await this.client.channels.fetch(channelId);
        if (!ch || !("sendTyping" in ch)) return;
        await (ch as unknown as { sendTyping: () => Promise<void> }).sendTyping();
      } catch {
        // Permissions/network — typing is best-effort.
      }
    };
    void send();
    timer = setInterval(() => {
      if (stopped) return;
      void send();
    }, 8_000);
    return () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
    };
  }

  async send(channelId: string, content: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !("send" in channel)) return;

    for (const chunk of splitMessage(content)) {
      await channel.send(chunk);
    }
  }

  async sendDM(userId: string, content: string): Promise<void> {
    const user = await this.client.users.fetch(userId);
    for (const chunk of splitMessage(content)) {
      await user.send(chunk);
    }
  }

  private shouldRespond(msg: DiscordMessage): boolean {
    // Never respond to ourselves
    if (msg.author.id === this.client.user?.id) return false;
    // Never respond to other bots
    if (msg.author.bot) return false;

    const discordConfig = getDiscordConfig(this.runtime.getConfig());
    if (!discordConfig) return false;

    // DMs
    if (!msg.guild) {
      return discordConfig.respondToDMs !== false;
    }

    // Guild messages: check guild allowlist
    if (discordConfig.allowedGuilds?.length) {
      if (!discordConfig.allowedGuilds.includes(msg.guild.id)) return false;
    }

    // A registered room owns its own routing. Without this, "@TAI <coder> take
    // a look" in a room fires twice — once down this legacy mention path and
    // once through the woken agent — and the user gets two replies.
    if (this.isRoomChannel(msg.channelId)) return false;

    // Only respond to @mentions in guilds
    if (discordConfig.respondToMentions !== false) {
      return msg.mentions.has(this.client.user!);
    }

    return false;
  }

  /**
   * Map an incoming Discord message to a project context using config's
   * `channels.discord.projectMappings`. Returns null when no mapping matches —
   * such messages stay in global mode.
   */
  private resolveMessageProject(msg: DiscordMessage): ProjectRef | null {
    const mappings = getDiscordConfig(this.runtime.getConfig())?.projectMappings;
    if (!mappings || mappings.length === 0) return null;

    const isDM = !msg.guild;
    let mapped: string | null = null;
    for (const m of mappings) {
      if ("channel" in m && m.channel === msg.channelId) {
        mapped = m.project;
        break;
      }
      if ("dm" in m && m.dm === true && isDM) {
        mapped = m.project;
        break;
      }
    }
    if (!mapped) return null;

    const ref = this.runtime.getProjectByName(mapped);
    if (!ref) {
      console.warn(`[discord] projectMappings names "${mapped}" but it is unknown or has no path — using global`);
      return null;
    }
    return ref;
  }

  private async handleMessage(msg: DiscordMessage): Promise<void> {
    if (!this.shouldRespond(msg)) return;

    // Strip the bot mention from the content
    const content = msg.content.replace(new RegExp(`<@!?${this.client.user!.id}>`, "g"), "").trim();

    if (!content) return;

    // Deduplicate: don't process if we're already handling a message from this user.
    // Project-scoped sessions are namespaced under their project id so the same user
    // in two different mapped channels gets isolated history (and parallel processing).
    const projectCtx = this.resolveMessageProject(msg);
    const userKey = this.runtime.makeSessionKey({
      channelId: "discord",
      userId: msg.author.id,
      project: projectCtx,
    });
    if (this.processing.has(userKey)) {
      await msg.reply("I'm still working on your previous message, hold on...");
      return;
    }

    this.processing.add(userKey);
    const source = msg.guild ? `#${(msg.channel as { name?: string }).name ?? msg.channelId}` : "DM";
    console.log(`[discord] ${msg.author.username} (${source}): "${content.slice(0, 80)}"`);

    // Handle slash commands
    if (isCommand(content)) {
      const config = this.runtime.getConfig();
      const result = await executeCommand(content, {
        config,
        currentAgent: this.userAgents.get(msg.author.id),
      });

      switch (result.type) {
        case "new_session": {
          const model = this.runtime.getModel();
          resetSession(this.runtime.db, userKey, model, config.agent.defaultProvider);
          await msg.reply("Started a new session.");
          this.processing.delete(userKey);
          return;
        }
        case "switch_profile": {
          this.userAgents.set(msg.author.id, result.profile);
          const model = this.runtime.getModel();
          resetSession(this.runtime.db, userKey, model, config.agent.defaultProvider);
          await msg.reply(`Switched to agent **${result.profile}**. Started a new session.`);
          this.processing.delete(userKey);
          return;
        }
        case "compact": {
          try {
            const model = this.runtime.getModel();
            const session = findOrCreateSession(this.runtime.db, userKey, model, config.agent.defaultProvider);
            const compactResult = await compactSession(this.runtime.db, session.id, this.runtime.getProvider(), model);
            await msg.reply(formatCompactResult(compactResult));
          } catch (err) {
            await msg.reply(`Error: ${(err as Error).message}`);
          }
          this.processing.delete(userKey);
          return;
        }
        case "help": {
          await msg.reply(result.text);
          this.processing.delete(userKey);
          return;
        }
        case "shell_output": {
          const output = result.output.slice(0, MAX_MESSAGE_LENGTH - 10);
          await msg.reply(`\`\`\`\n${output}\n\`\`\``);
          this.processing.delete(userKey);
          return;
        }
        case "error": {
          await msg.reply(result.message);
          this.processing.delete(userKey);
          return;
        }
        case "unknown_command": {
          await msg.reply(`Unknown command "/${result.name}". Type /help for available commands.`);
          this.processing.delete(userKey);
          return;
        }
        case "agent_prompt":
        case "shell_then_prompt": {
          // Fall through to agent loop below with the transformed prompt
          break;
        }
        default: {
          this.processing.delete(userKey);
          return;
        }
      }

      // agent_prompt / shell_then_prompt — send through the agent loop
      try {
        const agentResult = result as {
          type: "agent_prompt" | "shell_then_prompt";
          prompt: string;
          profile?: string;
          newSession?: boolean;
        };
        const agentName = agentResult.profile ?? this.userAgents.get(msg.author.id);

        if (agentResult.newSession) {
          const model = this.runtime.getModel();
          resetSession(this.runtime.db, userKey, model, config.agent.defaultProvider);
        }

        await this.runAgentAndReply(msg, userKey, agentResult.prompt, agentName, projectCtx);
      } catch (err) {
        console.error(`[discord] Error handling command from ${msg.author.username}:`, err);
        await msg.reply("Sorry, I encountered an error processing your command.").catch(() => {});
      } finally {
        this.processing.delete(userKey);
      }
      return;
    }

    // Regular message — send through agent loop
    try {
      const agentName = this.userAgents.get(msg.author.id);
      await this.runAgentAndReply(msg, userKey, content, agentName, projectCtx);
    } catch (err) {
      console.error(`[discord] Error handling message from ${msg.author.username}:`, err);
      await msg.reply("Sorry, I encountered an error processing your message.").catch(() => {});
    } finally {
      this.processing.delete(userKey);
    }
  }

  private async runAgentAndReply(
    msg: DiscordMessage,
    userKey: string,
    content: string,
    agentName?: string,
    project?: ProjectRef | null,
  ): Promise<void> {
    const stopTyping = this.indicateWorking(msg.channelId);

    try {
      const config = this.runtime.getConfig();
      const model = this.runtime.getModel();

      const session = findOrCreateSession(
        this.runtime.db,
        userKey,
        model,
        config.agent.defaultProvider,
        project?.id ?? null,
      );
      const hooks = this.runtime.resolveHooks({ agentName });
      const logPrefix = `[discord] [${msg.author.username}]`;

      // --- beforeRun hooks ---
      if (hooks.beforeRun.length > 0) {
        const { skipped } = await executeHooks(hooks.beforeRun, this.runtime.getTools(), {}, session.id, logPrefix);
        if (skipped) return;
      }

      const loopOpts = this.runtime.buildLoopOptions({ session, agentName, project });
      const approvalHandler = loopOpts.permissions
        ? new DiscordApprovalHandler((opts) => msg.reply(opts), msg.author.id)
        : undefined;

      const response = await runAgentLoop(content, {
        ...loopOpts,
        approvalHandler,
        ...this.runtime.defaultLoopObservers({ prefix: logPrefix }),
      });

      // --- afterRun hooks ---
      if (hooks.afterRun.length > 0) {
        await executeHooks(
          hooks.afterRun,
          this.runtime.getTools(),
          { response: response ?? "" },
          session.id,
          logPrefix,
        );
      }

      if (!response) return;

      const chunks = splitMessage(response);
      for (let i = 0; i < chunks.length; i++) {
        if (i === 0) {
          await msg.reply(chunks[i]);
        } else {
          await this.send(msg.channelId, chunks[i]);
        }
      }
      console.log(`[discord] Replied to ${msg.author.username}: "${response.slice(0, 80)}"`);
    } finally {
      stopTyping();
    }
  }

  private buildSlashCommands(): SlashCommandBuilder[] {
    const config = this.runtime.getConfig();
    const commands: SlashCommandBuilder[] = [];

    // /new
    commands.push(
      new SlashCommandBuilder().setName("new").setDescription("Start a new session") as SlashCommandBuilder,
    );

    // /agent — with agent choices
    const agentNames = Object.keys(config.agents);
    if (agentNames.length > 0) {
      const agentCmd = new SlashCommandBuilder().setName("agent").setDescription("Switch agent");
      agentCmd.addStringOption((opt) =>
        opt
          .setName("agent")
          .setDescription("Agent name")
          .setRequired(true)
          .addChoices(...agentNames.slice(0, 25).map((p) => ({ name: p, value: p }))),
      );
      commands.push(agentCmd as SlashCommandBuilder);
    }

    // /help
    commands.push(
      new SlashCommandBuilder().setName("help").setDescription("List available commands") as SlashCommandBuilder,
    );

    // /compact
    commands.push(
      new SlashCommandBuilder()
        .setName("compact")
        .setDescription("Summarize conversation to free context space") as SlashCommandBuilder,
    );

    // /context
    commands.push(
      new SlashCommandBuilder()
        .setName("context")
        .setDescription("Show context and knowledge base usage stats") as SlashCommandBuilder,
    );

    // /tasks
    const tasksCmd = new SlashCommandBuilder().setName("tasks").setDescription("List or create project tasks");
    tasksCmd.addStringOption((opt) =>
      opt
        .setName("action")
        .setDescription("Action to perform")
        .setRequired(true)
        .addChoices({ name: "list", value: "list" }, { name: "create", value: "create" }),
    );
    tasksCmd.addStringOption((opt) =>
      opt.setName("title").setDescription("Task title (for create)").setRequired(false),
    );
    tasksCmd.addStringOption((opt) =>
      opt
        .setName("status")
        .setDescription("Status filter (for list)")
        .setRequired(false)
        .addChoices(
          { name: "backlog", value: "backlog" },
          { name: "in_progress", value: "in_progress" },
          { name: "blocked", value: "blocked" },
          { name: "in_review", value: "in_review" },
          { name: "done", value: "done" },
        ),
    );
    commands.push(tasksCmd as SlashCommandBuilder);

    // /room is always registered, including when there are no rooms yet — its
    // `create` subcommand is how the first one gets made, so gating on "a room
    // exists" would lock the door from the inside. The other subcommands say
    // plainly that the channel isn't a room.
    commands.push(buildRoomCommand());

    // Config-driven commands
    for (const [name, cmd] of Object.entries(config.commands)) {
      // Discord command names must be 1-32 chars, lowercase, no spaces
      const safeName = name
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "")
        .slice(0, 32);
      if (!safeName) continue;

      const builder = new SlashCommandBuilder()
        .setName(safeName)
        .setDescription(cmd.description.slice(0, 100) || `Run /${safeName}`);

      // Add optional input option if the command/prompt uses {{input}}
      const usesInput = cmd.command?.includes("{{input}}") || cmd.prompt?.includes("{{input}}");
      if (usesInput) {
        builder.addStringOption((opt) =>
          opt.setName("input").setDescription("Input for the command").setRequired(false),
        );
      }

      commands.push(builder as SlashCommandBuilder);
    }

    return commands;
  }

  /**
   * Publish the slash commands.
   *
   * Two things here are deliberate.
   *
   * **Guild-scoped when we know the guild.** Global commands can take up to an
   * hour to reach clients, which reads exactly like "the commands don't work".
   * A guild overwrite is visible immediately, so a deployment that names its
   * guild gets commands the moment the bot starts. Without a guild id we fall
   * back to global and say so, because that delay is worth warning about.
   *
   * **One bulk overwrite, never a clear-then-write.** The overwrite already
   * replaces the whole set; clearing first only widens the window in which a
   * second sync can interleave. Two syncs landing together that way left every
   * command registered twice.
   */
  private async syncCommands(): Promise<void> {
    const config = getDiscordConfig(this.runtime.getConfig());
    const token = config?.token;
    const clientId = this.client.user?.id;
    if (!token || !clientId) return;

    const commands = this.buildSlashCommands();
    const body = commands.map((c) => c.toJSON());
    const guildId = config?.guildId ?? this.client.guilds.cache.first()?.id;
    const hash = createHash("sha256").update(JSON.stringify({ body, guildId })).digest("hex");
    if (hash === this.registeredCommandsHash) return;

    // Serialize: onReload and ClientReady can both land here at once.
    this.commandSync = this.commandSync
      .then(async () => {
        if (hash === this.registeredCommandsHash) return;
        const rest = new REST().setToken(token);
        if (guildId) {
          await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
          // Global copies would show up alongside the guild ones as duplicates.
          await rest.put(Routes.applicationCommands(clientId), { body: [] });
          console.log(`[discord] Synced ${commands.length} command(s) to guild ${guildId} — available now`);
        } else {
          await rest.put(Routes.applicationCommands(clientId), { body });
          console.log(
            `[discord] Synced ${commands.length} global command(s). Discord can take up to an hour to show these; set channels.discord.guildId for instant registration.`,
          );
        }
        this.registeredCommandsHash = hash;
      })
      .catch((err) => {
        console.error(`[discord] Command sync failed: ${(err as Error).message}`);
      });

    await this.commandSync;
  }

  private async handleInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    // Room management answers from the database, not the model — it should not
    // queue behind whatever the agent is doing, and it must not be swallowed by
    // the per-user "already processing" guard below.
    if (
      await handleRoomCommand(
        interaction,
        {
          store: this.runtime.getRoomStore(),
          identities: () => this.identities(),
          requestStatusUpdate: (room, askedBy) =>
            this.roomStatusRequester?.(room, askedBy) ??
            Promise.reject(new Error("The room watcher is not running, so nobody can be asked.")),
          postAsPerson: (room, speaker, to, body) => this.postAsPerson(room, speaker, to, body),
          resetAgentSession: (room, agent) => this.resetAgentSession(room, agent),
          rewindAgentSession: (room, agent, turns) => this.rewindAgentSession(room, agent, turns),
        },
        this.runtime.getConfig(),
      )
    ) {
      return;
    }

    const userId = interaction.user.id;
    const userKey = this.runtime.makeSessionKey({ channelId: "discord", userId });

    // Deduplicate
    if (this.processing.has(userKey)) {
      await interaction.reply({ content: "I'm still working on your previous message, hold on...", ephemeral: true });
      return;
    }

    this.processing.add(userKey);
    await interaction.deferReply();

    const username = interaction.user.username;
    console.log(`[discord] ${username} (slash): /${interaction.commandName}`);

    try {
      // Built-in /context command — handled directly, not through executeCommand
      if (interaction.commandName === "context") {
        const agentName = this.userAgents.get(userId);
        const reply = await this.buildContextReply(userId, agentName);
        await interaction.editReply(reply);
        return;
      }

      // Built-in /tasks command — handled directly, no agent loop
      if (interaction.commandName === "tasks") {
        const action = interaction.options.getString("action") ?? "list";
        if (action === "create") {
          const title = interaction.options.getString("title");
          if (!title) {
            await interaction.editReply("Title is required to create a task.");
            return;
          }
          const task = createProjectTask(this.runtime.db, {
            title,
            author: interaction.user.username,
          });
          await interaction.editReply(`Created task **${task.title}** (\`${task.id}\`)`);
        } else {
          const statusFilter = interaction.options.getString("status") ?? undefined;
          const { tasks: results, total } = queryProjectTasks(this.runtime.db, {
            status: statusFilter,
            limit: 10,
          });
          if (results.length === 0) {
            await interaction.editReply("No tasks found.");
          } else {
            const lines = [`**${total} task(s)**${results.length < total ? ` (showing ${results.length})` : ""}\n`];
            for (const t of results) {
              const tags = t.tags.length ? ` [${t.tags.join(", ")}]` : "";
              lines.push(`- **${t.title}** (\`${t.id}\`) — ${t.status}${tags}`);
            }
            await interaction.editReply(lines.join("\n"));
          }
        }
        return;
      }

      // Reconstruct text command string
      const inputOpt = interaction.options.getString("input") ?? "";
      const agentOpt = interaction.options.getString("agent") ?? interaction.options.getString("profile") ?? "";
      const argStr = agentOpt || inputOpt;
      const textCommand = argStr ? `/${interaction.commandName} ${argStr}` : `/${interaction.commandName}`;

      const config = this.runtime.getConfig();
      const result = await executeCommand(textCommand, {
        config,
        currentAgent: this.userAgents.get(userId),
      });

      switch (result.type) {
        case "new_session": {
          const model = this.runtime.getModel();
          resetSession(this.runtime.db, userKey, model, config.agent.defaultProvider);
          await interaction.editReply("Started a new session.");
          return;
        }
        case "switch_profile": {
          this.userAgents.set(userId, result.profile);
          const model = this.runtime.getModel();
          resetSession(this.runtime.db, userKey, model, config.agent.defaultProvider);
          await interaction.editReply(`Switched to agent **${result.profile}**. Started a new session.`);
          return;
        }
        case "compact": {
          try {
            const model = this.runtime.getModel();
            const session = findOrCreateSession(this.runtime.db, userKey, model, config.agent.defaultProvider);
            const compactResult = await compactSession(this.runtime.db, session.id, this.runtime.getProvider(), model);
            await interaction.editReply(formatCompactResult(compactResult));
          } catch (err) {
            await interaction.editReply(`Error: ${(err as Error).message}`);
          }
          return;
        }
        case "help": {
          await interaction.editReply(result.text);
          return;
        }
        case "shell_output": {
          const output = result.output.slice(0, MAX_MESSAGE_LENGTH - 10);
          await interaction.editReply(`\`\`\`\n${output}\n\`\`\``);
          return;
        }
        case "error": {
          await interaction.editReply(result.message);
          return;
        }
        case "unknown_command": {
          await interaction.editReply(`Unknown command "/${result.name}". Type /help for available commands.`);
          return;
        }
        case "agent_prompt":
        case "shell_then_prompt": {
          const agentResult = result as {
            type: "agent_prompt" | "shell_then_prompt";
            prompt: string;
            profile?: string;
            newSession?: boolean;
          };
          const agentName = agentResult.profile ?? this.userAgents.get(userId);

          if (agentResult.newSession) {
            const model = this.runtime.getModel();
            resetSession(this.runtime.db, userKey, model, config.agent.defaultProvider);
          }

          const response = await this.runAgentForInteraction(interaction, userKey, agentResult.prompt, agentName);
          if (response) {
            const chunks = splitMessage(response);
            await interaction.editReply(chunks[0]);
            for (let i = 1; i < chunks.length; i++) {
              await interaction.followUp(chunks[i]);
            }
            console.log(`[discord] Replied to ${username}: "${response.slice(0, 80)}"`);
          } else {
            await interaction.editReply("(No response)");
          }
          return;
        }
      }
    } catch (err) {
      console.error(`[discord] Error handling interaction from ${username}:`, err);
      await interaction.editReply("Sorry, I encountered an error processing your command.").catch(() => {});
    } finally {
      this.processing.delete(userKey);
    }
  }

  private async runAgentForInteraction(
    interaction: ChatInputCommandInteraction,
    userKey: string,
    content: string,
    agentName?: string,
  ): Promise<string | undefined> {
    const config = this.runtime.getConfig();
    const model = this.runtime.getModel();

    const session = findOrCreateSession(this.runtime.db, userKey, model, config.agent.defaultProvider);
    const hooks = this.runtime.resolveHooks({ agentName });
    const logPrefix = `[discord] [${interaction.user.username}]`;

    // --- beforeRun hooks ---
    if (hooks.beforeRun.length > 0) {
      const { skipped } = await executeHooks(hooks.beforeRun, this.runtime.getTools(), {}, session.id, logPrefix);
      if (skipped) return undefined;
    }

    const loopOpts = this.runtime.buildLoopOptions({ session, agentName });
    let approvalHandler: DiscordApprovalHandler | undefined;
    if (loopOpts.permissions && interaction.channel && "send" in interaction.channel) {
      const ch = interaction.channel;
      approvalHandler = new DiscordApprovalHandler(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (opts) => (ch as any).send(opts),
        interaction.user.id,
      );
    }

    const response = await runAgentLoop(content, {
      ...loopOpts,
      approvalHandler,
      ...this.runtime.defaultLoopObservers({ prefix: logPrefix }),
    });

    // --- afterRun hooks ---
    if (hooks.afterRun.length > 0) {
      await executeHooks(hooks.afterRun, this.runtime.getTools(), { response: response ?? "" }, session.id, logPrefix);
    }

    return response;
  }

  private async buildContextReply(userId: string, agentName?: string): Promise<string> {
    const config = this.runtime.getConfig();
    const userKey = this.runtime.makeSessionKey({ channelId: "discord", userId });
    const resolved = resolveAgent(
      agentName,
      config,
      this.runtime.getResolvableTools(),
      undefined,
      this.runtime.contextDir,
      this.runtime.kbDir,
    );

    // 1. System prompt (base + extra instructions)
    const basePrompt = BASE_SYSTEM_PROMPT + resolved.instructions;
    const basePromptTokens = estimateTokens({ role: "system", content: basePrompt });

    // 2. Context files
    let contextContent = "";
    if (resolved.skipGlobalContext && resolved.contextDir) {
      contextContent = await loadContextFiles(resolved.contextDir);
    } else {
      contextContent = await loadAllContext(this.runtime.contextDir, resolved.contextDir);
    }
    const contextTokens = contextContent ? estimateTokens({ role: "system", content: contextContent }) : 0;

    // 3. Tools (schema JSON)
    const tools = [...resolved.tools];
    const toolsJson = JSON.stringify(
      tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
    );
    const toolsTokens = Math.ceil(toolsJson.length / 4);

    // 4. Messages in current session
    const model = this.runtime.getModel();
    const session = findOrCreateSession(this.runtime.db, userKey, model, config.agent.defaultProvider);
    const messages = getSessionMessages(this.runtime.db, session.id);
    let messagesTokens = 0;
    for (const msg of messages) messagesTokens += estimateTokens(msg);

    // Total and context window. Prefer a per-model override from agent.models[];
    // fall back to the global agent.maxContextTokens.
    const totalTokens = basePromptTokens + contextTokens + toolsTokens + messagesTokens;
    const activeModelEntry = config.agent.models?.find((m) => m.model === model);
    const maxTokens = activeModelEntry?.maxContextTokens ?? config.agent.maxContextTokens;
    const pct = Math.round((totalTokens / maxTokens) * 100);

    const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`);

    const lines: string[] = [];
    lines.push(`**Context usage: ${pct}% (${fmtK(totalTokens)} / ${fmtK(maxTokens)})**`);
    lines.push(`- System prompt: ${fmtK(basePromptTokens)}`);
    lines.push(`- Context files: ${fmtK(contextTokens)}`);
    lines.push(`- Tools: ${fmtK(toolsTokens)} (${tools.length} tools)`);
    lines.push(`- Messages: ${fmtK(messagesTokens)} (${messages.length} msgs)`);

    // Context file breakdown
    if (contextContent) {
      lines.push("");
      lines.push("**Context files:**");
      // Parse the context content to extract individual file sections
      const filePattern = /^## (.+\.md)$/gm;
      let match: RegExpExecArray | null;
      const fileNames: string[] = [];
      const fileStarts: number[] = [];
      while ((match = filePattern.exec(contextContent)) !== null) {
        fileNames.push(match[1]);
        fileStarts.push(match.index);
      }
      for (let i = 0; i < fileNames.length; i++) {
        const start = fileStarts[i];
        const end = i + 1 < fileStarts.length ? fileStarts[i + 1] : contextContent.length;
        const section = contextContent.slice(start, end);
        const tokens = Math.ceil(section.length / 4);
        lines.push(`- ${fileNames[i]}: ${fmtK(tokens)}`);
      }
    }

    return lines.join("\n");
  }
}
