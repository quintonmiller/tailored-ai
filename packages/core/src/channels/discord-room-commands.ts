/**
 * `/room` — managing a room from inside Discord.
 *
 * These do the same things the `room` tool does, but for a person rather than
 * an agent: see who is here, add or drop an agent, read or set what the room is
 * for, ask everyone what they are working on.
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

export interface RoomCommandDeps {
  store: RoomStore;
  identities: () => IdentityResolver;
  /** Ask every subscribed agent to report in. Returns how many were asked. */
  requestStatusUpdate: (room: Room, askedBy: string) => Promise<number>;
  /** Forget an agent's conversation in a room. Returns how many messages went. */
  resetAgentSession: (room: Room, agent: string) => number;
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
      .addStringOption((o) =>
        o.setName("agent").setDescription("Which agent").setRequired(true).setAutocomplete(true),
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
        await deps.postAsPerson(room, interaction.user.username, [agent], message);
        await interaction.editReply(`Sent to **${agent}**.`);
        return true;
      }
      case "status": {
        // Not ephemeral: the answers land in the channel, so the request that
        // produced them should be visible too.
        await interaction.reply({ content: `Asking everyone in "${room.name}" for a status update…` });
        const asked = await deps.requestStatusUpdate(room, interaction.user.username);
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
    await interaction
      .reply({ content: `Failed: ${(err as Error).message}`, flags: MessageFlags.Ephemeral })
      .catch(() => {
        // The interaction may already be answered; the error is logged upstream.
      });
    return true;
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

  const room = await backend.createRoom({ name, purpose, createdBy: interaction.user.username });
  const stored = deps.store.upsertRoom(room, interaction.user.username);

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
  const wakeOn = (interaction.options.getString("wake") ?? "named") as "named" | "addressed" | "all" | "none";

  // Adding an agent that does not exist would look like it worked and then
  // never speak, which is the failure mode this codebase keeps hitting.
  if (!config.agents?.[name]) {
    const known = Object.keys(config.agents ?? {}).join(", ");
    return `No agent named "${name}". Configured agents: ${known || "none"}.`;
  }

  deps.store.subscribe({ agent: name, roomRef: formatRoomRef(room.ref), wakeOn, source: "agent" });
  return `**${name}** now watches "${room.name}" (${wakeOn}). Takes effect immediately.`;
}

/**
 * Start an agent over in this room.
 *
 * A tool that was broken and then fixed does not help an agent whose history
 * says it is broken — it stops trying, which is reasonable behaviour on bad
 * evidence and impossible to argue it out of. Its read cursor is left alone, so
 * it resumes from now rather than replaying the conversation it just forgot.
 */
function resetAgent(
  interaction: ChatInputCommandInteraction,
  deps: RoomCommandDeps,
  room: Room,
): string {
  const name = (interaction.options.getString("agent") ?? "").trim();
  const subscribed = deps.store
    .listSubscriptionsForRoom(formatRoomRef(room.ref))
    .some((s) => s.agent === name);
  if (!subscribed) {
    return `**${name}** is not in "${room.name}". In this room: ${roomAgents(deps, room).join(", ") || "nobody"}.`;
  }

  const cleared = deps.resetAgentSession(room, name);
  return cleared > 0
    ? `**${name}** has forgotten this room — ${cleared} message(s) cleared. It keeps its place, so it starts from what happens next.`
    : `**${name}** had nothing to forget here.`;
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
