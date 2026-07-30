/**
 * `/room` — managing a room from inside Discord.
 *
 * These do the same things the `room` tool does, but for a person rather than
 * an agent: see who is here, add or drop an agent, read or set what the room is
 * for, ask everyone what they are working on, say something to all of them.
 *
 * Three ways to reach agents, and the difference matters:
 *   `ping <agent> <msg>` — one agent, your words, posted as you.
 *   `all <msg>`          — every agent that can wake, your words, posted as you.
 *   `status`             — every agent, a canned question, no message in the
 *                          transcript (see `requestStatusUpdate`).
 *
 * Kept as one command with subcommands rather than six top-level commands.
 * Discord shows them under one entry, and the deployment's global command
 * namespace stays free for the user's own `config.commands`.
 */

import {
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import type { AgentConfig } from "../config.js";
import type { IdentityResolver } from "../rooms/identities.js";
import { getRoomBackend } from "../rooms/registry.js";
import type { RoomStore } from "../rooms/store.js";
import { formatRoomRef, type Room } from "../rooms/types.js";

export const ROOM_COMMAND_NAME = "room";

/**
 * What to call the person who ran the command.
 *
 * Discord hands us a username; rooms speak in identity labels. Stamping the
 * username meant a person declared as `quinton: "1073…"` showed up in the
 * transcript as `t3hlazy1`, so an agent addressed the only name it had seen and
 * got `Unknown participant(s): t3hlazy1` back from a validator that had never
 * heard of it. Resolve through the account id — the one part of a person that
 * cannot be spelled two ways — and fall back to the username only for someone
 * we genuinely do not know.
 */
function personLabel(interaction: ChatInputCommandInteraction, identities: IdentityResolver): string {
  return declaredLabel(interaction, identities) ?? interaction.user.username;
}

/**
 * The declared identity of whoever ran the command, or null when all we have is
 * a Discord username.
 *
 * The difference is load-bearing, not cosmetic. A room message is parsed back
 * out of Discord as an envelope, and `[someone]` is only accepted as a speaker
 * when that name is a known identity. An undeclared username fails that check,
 * so the message comes back with no speaker and `fromSelf: true` — and
 * `wakeReason` drops it for every subscriber before it ever looks at who was
 * addressed. The post lands in the channel and wakes nobody.
 */
function declaredLabel(interaction: ChatInputCommandInteraction, identities: IdentityResolver): string | null {
  return identities.byNativeId("discord", interaction.user.id)?.label ?? null;
}

export interface RoomCommandDeps {
  store: RoomStore;
  identities: () => IdentityResolver;
  /** Ask every subscribed agent to report in. Returns how many were asked. */
  requestStatusUpdate: (room: Room, askedBy: string) => Promise<number>;
  /**
   * Forget an agent's conversation for a room. Returns how many messages went
   * and whether that memory was this room's alone or shared across all of them.
   */
  resetAgentSession: (room: Room, agent: string) => { cleared: number; scope: "room" | "shared" };
  /**
   * Take an agent's conversation back N turns, or restore the last rewind when
   * `turns` is 0. Nothing is deleted — see `agent/rewind.ts`.
   */
  rewindAgentSession: (
    room: Room,
    agent: string,
    turns: number,
  ) => Promise<{
    scope: "room" | "shared";
    rewound?: { turns: number; messages: number; excerpt: string };
    restored?: number;
    remaining: number;
  }>;
  /** Post into a room as a person, addressed to one agent. */
  postAsPerson: (room: Room, speaker: string, to: string[], body: string) => Promise<void>;
}

export function buildRoomCommand(): SlashCommandBuilder {
  const cmd = new SlashCommandBuilder().setName(ROOM_COMMAND_NAME).setDescription("Manage this room");

  cmd.addSubcommand((s) =>
    s
      .setName("create")
      .setDescription("Open a new room")
      .addStringOption((o) => o.setName("name").setDescription("Room name").setRequired(true))
      .addStringOption((o) => o.setName("purpose").setDescription("What the room is for").setRequired(false))
      .addStringOption((o) => o.setName("agents").setDescription("Agents to add, comma separated").setRequired(false)),
  );

  cmd.addSubcommand((s) =>
    s
      .setName("ping")
      .setDescription("Send a message to one agent in this room")
      .addStringOption((o) =>
        // Autocompleted from the agents actually in this room. Typing the name
        // by hand is how "@agent:channel-manager" happened — it looked like an
        // address, resolved to nothing, and quietly went to everyone instead.
        o.setName("agent").setDescription("Which agent").setRequired(true).setAutocomplete(true),
      )
      .addStringOption((o) => o.setName("message").setDescription("What to say").setRequired(true)),
  );

  cmd.addSubcommand((s) => s.setName("members").setDescription("Who is in this room"));

  cmd.addSubcommand((s) =>
    s
      .setName("add")
      .setDescription("Add an agent to this room")
      .addStringOption((o) => o.setName("agent").setDescription("Agent name").setRequired(true))
      .addStringOption((o) =>
        o
          .setName("wake")
          .setDescription("What makes it run. Default: named")
          .setRequired(false)
          .addChoices(
            { name: "named — only when someone writes its name", value: "named" },
            { name: "addressed — that, plus loose questions", value: "addressed" },
            { name: "all — every message", value: "all" },
            { name: "none — read-only, never runs", value: "none" },
          ),
      ),
  );

  cmd.addSubcommand((s) =>
    s
      .setName("reset")
      .setDescription("Clear an agent's memory of this room and start it fresh")
      .addStringOption((o) => o.setName("agent").setDescription("Which agent").setRequired(true).setAutocomplete(true)),
  );

  cmd.addSubcommand((s) =>
    s
      .setName("rewind")
      .setDescription("Take an agent's conversation back a few turns. Nothing is deleted — undo with turns: 0")
      .addStringOption((o) => o.setName("agent").setDescription("Which agent").setRequired(true).setAutocomplete(true))
      .addIntegerOption((o) =>
        o
          .setName("turns")
          .setDescription("How many turns to take back. 0 restores the last rewind.")
          .setRequired(false)
          .setMinValue(0)
          .setMaxValue(50),
      ),
  );

  cmd.addSubcommand((s) =>
    s
      .setName("remove")
      .setDescription("Remove an agent from this room")
      .addStringOption((o) => o.setName("agent").setDescription("Agent name").setRequired(true)),
  );

  cmd.addSubcommand((s) =>
    s
      .setName("purpose")
      .setDescription("Show what this room is for, or set it")
      .addStringOption((o) =>
        o.setName("text").setDescription("New purpose. Omit to read the current one.").setRequired(false),
      ),
  );

  cmd.addSubcommand((s) => s.setName("status").setDescription("Ask every agent here what it is working on"));

  cmd.addSubcommand((s) =>
    s
      .setName("all")
      .setDescription("Say something to every agent in this room")
      .addStringOption((o) => o.setName("message").setDescription("What to say").setRequired(true)),
  );

  return cmd as SlashCommandBuilder;
}

/**
 * Handle a `/room` interaction. Returns false when the command is not ours, so
 * the caller can fall through to its existing command handling.
 */
export async function handleRoomCommand(
  interaction: ChatInputCommandInteraction,
  deps: RoomCommandDeps,
  config: AgentConfig,
): Promise<boolean> {
  if (interaction.commandName !== ROOM_COMMAND_NAME) return false;

  const sub = interaction.options.getSubcommand();

  // `create` is the one subcommand that does NOT need to be run inside a room —
  // that is the whole point of it, and requiring one would leave no way to make
  // the first.
  if (sub === "create") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      await interaction.editReply(await createRoom(interaction, deps, config));
    } catch (err) {
      await interaction.editReply(`Failed: ${(err as Error).message}`);
    }
    return true;
  }

  const ref = `discord:${interaction.channelId}`;
  const room = deps.store.getRoomByRef(ref);
  if (!room) {
    await interaction.reply({
      content:
        "This channel isn't a room. Register it under `rooms.rooms` in config, or have an agent open one with the `room` tool.",
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  try {
    switch (sub) {
      case "members":
        await interaction.reply({ content: renderMembers(deps, room), flags: MessageFlags.Ephemeral });
        return true;
      case "add":
        await interaction.reply({
          content: await addAgent(interaction, deps, config, room),
          flags: MessageFlags.Ephemeral,
        });
        return true;
      case "reset":
        await interaction.reply({ content: resetAgent(interaction, deps, room), flags: MessageFlags.Ephemeral });
        return true;
      case "rewind":
        await interaction.reply({
          content: await rewindAgent(interaction, deps, room),
          flags: MessageFlags.Ephemeral,
        });
        return true;
      case "remove":
        await interaction.reply({ content: removeAgent(interaction, deps, room), flags: MessageFlags.Ephemeral });
        return true;
      case "purpose":
        await interaction.reply({ content: await purpose(interaction, deps, room), flags: MessageFlags.Ephemeral });
        return true;
      case "ping": {
        const agent = (interaction.options.getString("agent") ?? "").trim();
        const message = (interaction.options.getString("message") ?? "").trim();
        const identities = deps.identities();
        if (!identities.get(agent)) {
          await interaction.reply({
            content: `No participant called "${agent}". In this room: ${roomAgents(deps, room).join(", ") || "nobody"}.`,
            flags: MessageFlags.Ephemeral,
          });
          return true;
        }
        // Answered publicly: the question and its answer belong in the room.
        await interaction.deferReply();
        await deps.postAsPerson(room, personLabel(interaction, identities), [agent], message);
        await interaction.editReply(`Sent to **${agent}**.`);
        return true;
      }
      case "all": {
        const message = (interaction.options.getString("message") ?? "").trim();
        if (!message) {
          await interaction.reply({
            content: "Nothing to send — the message was empty.",
            flags: MessageFlags.Ephemeral,
          });
          return true;
        }
        const identities = deps.identities();
        const agents = wakeableAgents(deps, room);
        if (agents.length === 0) {
          const subscribed = roomAgents(deps, room).length;
          await interaction.reply({
            content:
              subscribed === 0
                ? `Nobody is subscribed to "${room.name}" yet. Add someone with \`/room add\`.`
                : `All ${subscribed} agent(s) in "${room.name}" have \`wakeOn: none\`, so none of them would hear this. \`/room members\` shows their settings.`,
            flags: MessageFlags.Ephemeral,
          });
          return true;
        }
        // Posted as the person, addressed to everyone who can hear it — unlike
        // `status`, the words are genuinely theirs, so putting them in the
        // transcript under their own name is accurate rather than a fake human
        // turn. Going through the room means the ordinary wake path applies:
        // `pass` still works and repeat suppression still holds.
        //
        // The agent-turn counter also resets — but only for a speaker the
        // identity layer recognises, since that reset keys off the message
        // parsing back as a human turn. See `declaredLabel`.
        const declared = declaredLabel(interaction, identities);
        const speaker = declared ?? interaction.user.username;
        await interaction.deferReply();
        await deps.postAsPerson(room, speaker, agents, message);
        await interaction.editReply(
          `Sent to ${agents.length} agent(s): ${agents.join(", ")}.${
            declared
              ? ""
              : `\n\n⚠️ Your Discord account isn't declared under \`rooms.identities\`, so agents may not recognise **${speaker}** as a person and none of them may answer. Add \`${speaker}: "${interaction.user.id}"\` under \`rooms.identities\` to fix it.`
          }`,
        );
        return true;
      }
      case "status": {
        // Not ephemeral: the answers land in the channel, so the request that
        // produced them should be visible too.
        await interaction.reply({ content: `Asking everyone in "${room.name}" for a status update…` });
        const asked = await deps.requestStatusUpdate(room, personLabel(interaction, deps.identities()));
        await interaction.followUp({
          content: asked > 0 ? `Asked ${asked} agent(s).` : "Nobody is subscribed to this room yet.",
          flags: MessageFlags.Ephemeral,
        });
        return true;
      }
      default:
        await interaction.reply({ content: `Unknown subcommand "${sub}".`, flags: MessageFlags.Ephemeral });
        return true;
    }
  } catch (err) {
    await reportFailure(interaction, err);
    return true;
  }
}

/**
 * Tell the user a subcommand failed, whatever state the interaction is in.
 *
 * This used to be an unconditional `interaction.reply()`. For the branches that
 * defer first (`ping`, `all`) or reply first (`status`), discord.js throws
 * `InteractionAlreadyReplied` — and the throw was swallowed by an empty
 * `.catch()`, leaving the user on a "thinking…" spinner forever. Nothing logged
 * it either: `handleRoomCommand` returned true, so the caller's own error
 * handler never saw it, and the comment claiming it was "logged upstream" was
 * simply wrong.
 *
 * A command that fails silently is worse than one that throws, because the only
 * evidence is a spinner that never resolves.
 */
async function reportFailure(interaction: ChatInputCommandInteraction, err: unknown): Promise<void> {
  const message = `Failed: ${(err as Error).message}`;
  // Log first and unconditionally — whatever Discord does with the reply, the
  // operator needs the stack.
  console.error(`[discord] /room ${safeSubcommand(interaction)} failed:`, err);
  try {
    if (interaction.deferred && !interaction.replied) {
      await interaction.editReply(message);
    } else if (interaction.replied) {
      await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    }
  } catch (nested) {
    // The interaction genuinely cannot be answered (expired, or Discord is
    // down). Already logged above, so there is nothing further to do.
    console.error("[discord] could not deliver the failure notice:", nested);
  }
}

/** Subcommand name for logging, without throwing when there isn't one. */
function safeSubcommand(interaction: ChatInputCommandInteraction): string {
  try {
    return interaction.options.getSubcommand();
  } catch {
    return "(unknown)";
  }
}

/**
 * Open a channel and register it as a room, in one step.
 *
 * Without this the only ways to make a room were to edit config.yaml by hand or
 * to find an agent that happens to carry the `room` tool — neither of which is
 * something you should have to know.
 */
async function createRoom(
  interaction: ChatInputCommandInteraction,
  deps: RoomCommandDeps,
  config: AgentConfig,
): Promise<string> {
  const name = (interaction.options.getString("name") ?? "").trim();
  const purpose = (interaction.options.getString("purpose") ?? "").trim();
  const agents = (interaction.options.getString("agents") ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);

  if (!name) return "A room needs a name.";
  const existing = deps.store.getRoomByName(name);
  if (existing) return `"${name}" already exists — <#${existing.ref.id}>.`;

  const backend = getRoomBackend("discord");
  if (!backend?.createRoom) return "Discord is not connected, so no channel can be created right now.";

  const opener = personLabel(interaction, deps.identities());
  const room = await backend.createRoom({ name, purpose, createdBy: opener });
  const stored = deps.store.upsertRoom(room, opener);

  const unknown: string[] = [];
  const added: string[] = [];
  for (const agent of agents) {
    if (!config.agents?.[agent]) {
      unknown.push(agent);
      continue;
    }
    deps.store.subscribe({ agent, roomRef: formatRoomRef(stored.ref), wakeOn: "named", source: "agent" });
    added.push(agent);
  }

  const lines = [`Created <#${stored.ref.id}>.`];
  if (purpose) lines.push(`Purpose: ${purpose}`);
  if (added.length > 0) lines.push(`Added: ${added.join(", ")} (wake: named).`);
  if (unknown.length > 0) lines.push(`Not added — no such agent: ${unknown.join(", ")}.`);
  if (added.length === 0) lines.push("Add agents with `/room add` in the new channel.");
  return lines.join("\n");
}

/** Agent labels subscribed to a room, for autocomplete and error messages. */
export function roomAgents(deps: RoomCommandDeps, room: Room): string[] {
  const identities = deps.identities();
  return deps.store.listSubscriptionsForRoom(formatRoomRef(room.ref)).map((s) => identities.labelForAgent(s.agent));
}

/**
 * The agents in a room that a message can actually reach.
 *
 * `wakeOn: "none"` is a subscription that reads but never wakes, so addressing
 * one is silent. Excluding them keeps the reply's count honest — "sent to 9" is
 * a claim about delivery, and counting an agent that cannot hear it makes the
 * command lie about what it did. Mirrors the filter `requestStatusUpdate` uses.
 */
export function wakeableAgents(deps: RoomCommandDeps, room: Room): string[] {
  const identities = deps.identities();
  return deps.store
    .listSubscriptionsForRoom(formatRoomRef(room.ref))
    .filter((s) => s.wakeOn !== "none")
    .map((s) => identities.labelForAgent(s.agent));
}

/**
 * Suggest the agents in this room as the user types. Returns false when the
 * interaction is not ours.
 */
export function handleRoomAutocomplete(interaction: AutocompleteInteraction, deps: RoomCommandDeps): boolean {
  if (interaction.commandName !== ROOM_COMMAND_NAME) return false;

  const room = deps.store.getRoomByRef(`discord:${interaction.channelId}`);
  const typed = (interaction.options.getFocused() ?? "").toLowerCase();
  const names = room ? roomAgents(deps, room) : [];
  const matches = names.filter((n) => n.toLowerCase().includes(typed)).slice(0, 25);

  void interaction.respond(matches.map((n) => ({ name: n, value: n })));
  return true;
}

function renderMembers(deps: RoomCommandDeps, room: Room): string {
  const ref = formatRoomRef(room.ref);
  const identities = deps.identities();
  const subs = deps.store.listSubscriptionsForRoom(ref);
  if (subs.length === 0) return `Nobody is subscribed to "${room.name}" yet. Add one with \`/room add\`.`;

  const lines = subs.map((s) => {
    const label = identities.labelForAgent(s.agent);
    return `• **${label}** — ${s.deliver}/${s.wakeOn}`;
  });
  return [`**${room.name}** — ${subs.length} agent(s):`, ...lines].join("\n");
}

async function addAgent(
  interaction: ChatInputCommandInteraction,
  deps: RoomCommandDeps,
  config: AgentConfig,
  room: Room,
): Promise<string> {
  const name = (interaction.options.getString("agent") ?? "").trim();
  // Undefined when the option was left out, so re-adding an agent that is
  // already here does not quietly reset a wake mode it chose for itself.
  const asked = interaction.options.getString("wake") as "named" | "addressed" | "all" | "none" | null;

  // Adding an agent that does not exist would look like it worked and then
  // never speak, which is the failure mode this codebase keeps hitting.
  if (!config.agents?.[name]) {
    const known = Object.keys(config.agents ?? {}).join(", ");
    return `No agent named "${name}". Configured agents: ${known || "none"}.`;
  }

  const ref = formatRoomRef(room.ref);
  const wakeOn = asked ?? (deps.store.getSubscription(name, ref) ? undefined : "named");
  const sub = deps.store.subscribe({ agent: name, roomRef: ref, wakeOn, source: "agent" });
  return `**${name}** now watches "${room.name}" (${sub.wakeOn}). Takes effect immediately.`;
}

/**
 * Start an agent over in this room.
 *
 * A tool that was broken and then fixed does not help an agent whose history
 * says it is broken — it stops trying, which is reasonable behaviour on bad
 * evidence and impossible to argue it out of. Its read cursor is left alone, so
 * it resumes from now rather than replaying the conversation it just forgot.
 */
function resetAgent(interaction: ChatInputCommandInteraction, deps: RoomCommandDeps, room: Room): string {
  const name = (interaction.options.getString("agent") ?? "").trim();
  const subscribed = deps.store.listSubscriptionsForRoom(formatRoomRef(room.ref)).some((s) => s.agent === name);
  if (!subscribed) {
    return `**${name}** is not in "${room.name}". In this room: ${roomAgents(deps, room).join(", ") || "nobody"}.`;
  }

  const { cleared, scope } = deps.resetAgentSession(room, name);
  if (cleared === 0) return `**${name}** had nothing to forget.`;

  // Say which memory went. An agent on a shared session has one conversation
  // covering every room it is in, so "forgotten this room" would be a quiet
  // lie about how much was just thrown away.
  const what =
    scope === "shared"
      ? `has forgotten every room — ${cleared} message(s) cleared, because it keeps one shared memory`
      : `has forgotten this room — ${cleared} message(s) cleared`;
  return `**${name}** ${what}. It keeps its place, so it starts from what happens next.`;
}

/**
 * Take a conversation back a few turns, or restore the last rewind.
 *
 * Distinct from `reset`, which throws the whole conversation away. Most
 * conversations that go wrong go wrong at a point you can name — one misread
 * instruction, one tool result that poisons everything after it — and what you
 * want then is to drop the tail, not the history.
 *
 * The reply quotes the first thing being taken back. A rewind is counted in
 * turns, and nobody remembers exactly how many turns ago something was said,
 * so the count alone gives no way to tell a correct cut from an off-by-one.
 */
async function rewindAgent(
  interaction: ChatInputCommandInteraction,
  deps: RoomCommandDeps,
  room: Room,
): Promise<string> {
  const name = (interaction.options.getString("agent") ?? "").trim();
  const subscribed = deps.store.listSubscriptionsForRoom(formatRoomRef(room.ref)).some((s) => s.agent === name);
  if (!subscribed) {
    return `**${name}** is not in "${room.name}". In this room: ${roomAgents(deps, room).join(", ") || "nobody"}.`;
  }

  const turns = interaction.options.getInteger("turns") ?? 1;
  const result = await deps.rewindAgentSession(room, name, turns);

  // Shared-session agents keep one conversation across every room they are in,
  // so "this room" would be a quiet lie about the reach of the change — the
  // same distinction `reset` draws.
  const reach = result.scope === "shared" ? " across every room, since it keeps one shared memory" : "";

  if (turns === 0) {
    if (!result.restored) return `**${name}** has no rewind to undo.`;
    return `Restored ${result.restored} message(s) to **${name}**${reach}. ${result.remaining} turn(s) visible.`;
  }

  if (!result.rewound) return `**${name}** has nothing to take back.`;

  const { turns: took, messages, excerpt } = result.rewound;
  const quoted = excerpt ? `\n> ${excerpt}${excerpt.length >= 140 ? "…" : ""}` : "";
  return (
    `**${name}** rewound ${took} turn(s) — ${messages} message(s) hidden${reach}. ` +
    `${result.remaining} turn(s) left. Nothing was deleted; \`/room rewind agent:${name} turns:0\` puts it back.` +
    `\nFirst thing taken back:${quoted}`
  );
}

function removeAgent(interaction: ChatInputCommandInteraction, deps: RoomCommandDeps, room: Room): string {
  const name = (interaction.options.getString("agent") ?? "").trim();
  const ref = formatRoomRef(room.ref);
  const dropped = deps.store.unsubscribe(name, ref);
  deps.store.removeMember(ref, name);
  return dropped ? `**${name}** no longer watches "${room.name}".` : `**${name}** was not watching "${room.name}".`;
}

async function purpose(interaction: ChatInputCommandInteraction, deps: RoomCommandDeps, room: Room): Promise<string> {
  const text = (interaction.options.getString("text") ?? "").trim();
  if (!text) {
    return room.purpose
      ? `**${room.name}** — ${room.purpose}`
      : `"${room.name}" has no purpose set. Set one with \`/room purpose text:…\`.`;
  }

  deps.store.upsertRoom({ ...room, purpose: text });

  const backend = getRoomBackend(room.ref.backend);
  if (backend?.setPurpose) {
    try {
      await backend.setPurpose(room.ref.id, text);
      return `Purpose set, and the channel topic now shows it. Every agent woken here will be told:\n> ${text}`;
    } catch (err) {
      return `Purpose set for the agents, but the channel topic could not be updated (${(err as Error).message}).`;
    }
  }
  return `Purpose set. Every agent woken here will be told:\n> ${text}`;
}
