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
import { compactSession, formatCompactResult } from "../agent/compact.js";
import { executeHooks } from "../agent/hooks.js";
import { estimateTokens, runAgentLoop } from "../agent/loop.js";
import { resolveAgent } from "../agent/agents.js";
import { BASE_SYSTEM_PROMPT } from "../agent/prompt.js";
import { findOrCreateSession, resetSession } from "../agent/session.js";
import { executeCommand, isCommand } from "../commands.js";
import { loadAllContext, loadContextFiles } from "../context.js";
import { getSessionMessages } from "../db/queries.js";
import { createProjectTask, queryProjectTasks } from "../db/task-queries.js";
import type { AgentRuntime } from "../runtime.js";
import { DiscordApprovalHandler } from "./discord-approval.js";
import type { Channel, IncomingMessage } from "./interface.js";

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

export class DiscordChannel implements Channel {
  id = "discord";
  type = "discord";

  private client: Client;
  private runtime: AgentRuntime;
  private messageHandler?: (msg: IncomingMessage) => void;
  private processing = new Set<string>();
  private userAgents = new Map<string, string>();
  private registeredCommandsHash = "";

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
    const token = this.runtime.getConfig().channels.discord?.token;
    if (!token) {
      throw new Error("Discord token not configured");
    }

    this.client.on(Events.ClientReady, (c) => {
      console.log(`[discord] Logged in as ${c.user.tag}`);
      this.syncCommands().catch((err) => {
        console.error("[discord] Failed to sync application commands:", (err as Error).message);
      });
    });

    this.client.on(Events.MessageCreate, (msg) => this.handleMessage(msg));

    this.client.on(Events.InteractionCreate, (interaction) => {
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
    this.client.destroy();
    console.log("[discord] Disconnected");
  }

  onMessage(handler: (msg: IncomingMessage) => void): void {
    this.messageHandler = handler;
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

    const discordConfig = this.runtime.getConfig().channels.discord;
    if (!discordConfig) return false;

    // DMs
    if (!msg.guild) {
      return discordConfig.respondToDMs !== false;
    }

    // Guild messages: check guild allowlist
    if (discordConfig.allowedGuilds?.length) {
      if (!discordConfig.allowedGuilds.includes(msg.guild.id)) return false;
    }

    // Only respond to @mentions in guilds
    if (discordConfig.respondToMentions !== false) {
      return msg.mentions.has(this.client.user!);
    }

    return false;
  }

  private async handleMessage(msg: DiscordMessage): Promise<void> {
    if (!this.shouldRespond(msg)) return;

    // Strip the bot mention from the content
    const content = msg.content.replace(new RegExp(`<@!?${this.client.user!.id}>`, "g"), "").trim();

    if (!content) return;

    // Emit to handler if registered
    if (this.messageHandler) {
      this.messageHandler({
        id: msg.id,
        channelId: msg.channelId,
        authorId: msg.author.id,
        authorName: msg.author.displayName ?? msg.author.username,
        content,
        isDM: !msg.guild,
        isMention: msg.mentions.has(this.client.user!),
      });
    }

    // Deduplicate: don't process if we're already handling a message from this user
    const userKey = `discord:${msg.author.id}`;
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

        await this.runAgentAndReply(msg, userKey, agentResult.prompt, agentName);
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
      await this.runAgentAndReply(msg, userKey, content, agentName);
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
  ): Promise<void> {
    const canType = "sendTyping" in msg.channel;
    if (canType) {
      await (msg.channel as { sendTyping: () => Promise<void> }).sendTyping();
    }
    const typingInterval = canType
      ? setInterval(() => {
          (msg.channel as { sendTyping: () => Promise<void> }).sendTyping().catch(() => {});
        }, 8_000)
      : undefined;

    const config = this.runtime.getConfig();
    const model = this.runtime.getModel();

    const session = findOrCreateSession(this.runtime.db, userKey, model, config.agent.defaultProvider);
    const hooks = this.runtime.resolveHooks({ agentName });
    const logPrefix = `[discord] [${msg.author.username}]`;

    // --- beforeRun hooks ---
    if (hooks.beforeRun.length > 0) {
      const { skipped } = await executeHooks(hooks.beforeRun, this.runtime.getTools(), {}, session.id, logPrefix);
      if (skipped) {
        if (typingInterval) clearInterval(typingInterval);
        return;
      }
    }

    const loopOpts = this.runtime.buildLoopOptions({ session, agentName });
    const approvalHandler = loopOpts.permissions
      ? new DiscordApprovalHandler((opts) => msg.reply(opts), msg.author.id)
      : undefined;

    const response = await runAgentLoop(content, {
      ...loopOpts,
      approvalHandler,
      onToolCall: (name, args) => {
        console.log(`${logPrefix} tool: ${name}(${JSON.stringify(args)})`);
      },
      onApprovalRequest: (req) => {
        console.log(`${logPrefix} approval requested: ${req.description}`);
      },
      onApprovalResponse: (req, res) => {
        console.log(
          `${logPrefix} approval ${res.approved ? "granted" : "denied"}: ${req.toolName} (${res.responseTimeMs}ms)`,
        );
      },
    });

    // --- afterRun hooks ---
    if (hooks.afterRun.length > 0) {
      await executeHooks(hooks.afterRun, this.runtime.getTools(), { response: response ?? "" }, session.id, logPrefix);
    }

    if (typingInterval) clearInterval(typingInterval);

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
    const tasksCmd = new SlashCommandBuilder()
      .setName("tasks")
      .setDescription("List or create project tasks");
    tasksCmd.addStringOption((opt) =>
      opt
        .setName("action")
        .setDescription("Action to perform")
        .setRequired(true)
        .addChoices(
          { name: "list", value: "list" },
          { name: "create", value: "create" },
        ),
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

  private async syncCommands(): Promise<void> {
    const token = this.runtime.getConfig().channels.discord?.token;
    const clientId = this.client.user?.id;
    if (!token || !clientId) return;

    const commands = this.buildSlashCommands();
    const body = commands.map((c) => c.toJSON());
    const json = JSON.stringify(body);

    // Skip if nothing changed
    const hash = createHash("sha256").update(json).digest("hex");
    if (hash === this.registeredCommandsHash) return;

    const rest = new REST().setToken(token);
    // Clear all existing commands first, then register new ones
    await rest.put(Routes.applicationCommands(clientId), { body: [] });
    await rest.put(Routes.applicationCommands(clientId), { body });
    this.registeredCommandsHash = hash;
    console.log(`[discord] Synced ${commands.length} application command(s)`);
  }

  private async handleInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    const userId = interaction.user.id;
    const userKey = `discord:${userId}`;

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
      onToolCall: (name, args) => {
        console.log(`${logPrefix} tool: ${name}(${JSON.stringify(args)})`);
      },
      onApprovalRequest: (req) => {
        console.log(`${logPrefix} approval requested: ${req.description}`);
      },
      onApprovalResponse: (req, res) => {
        console.log(
          `${logPrefix} approval ${res.approved ? "granted" : "denied"}: ${req.toolName} (${res.responseTimeMs}ms)`,
        );
      },
    });

    // --- afterRun hooks ---
    if (hooks.afterRun.length > 0) {
      await executeHooks(hooks.afterRun, this.runtime.getTools(), { response: response ?? "" }, session.id, logPrefix);
    }

    return response;
  }

  private async buildContextReply(userId: string, agentName?: string): Promise<string> {
    const config = this.runtime.getConfig();
    const userKey = `discord:${userId}`;
    const resolved = resolveAgent(
      agentName,
      config,
      this.runtime.getTools(),
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

    // Total and context window
    const totalTokens = basePromptTokens + contextTokens + toolsTokens + messagesTokens;
    const maxTokens = config.agent.maxContextTokens;
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
