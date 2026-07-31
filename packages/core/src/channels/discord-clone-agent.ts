import {
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import type { AgentConfig, AgentDefinition } from "../config.js";
import { type ConfigWriteHost, ConfigWriteRejected, updateRawConfig } from "../config-write.js";
import { splitMessage } from "./split-message.js";

/**
 * `/clone-agent` — copy an agent's configuration to a new name, and nothing else.
 *
 * Done by hand this is four steps and three of them are checks: copy the block
 * under `agents:` in config.yaml, then confirm the copy has no core memory, no
 * sessions, no notes, and no room subscriptions. The checks exist because the
 * interesting failure is the silent one — a "fresh" clone that inherited the
 * original's persona, or that woke up in the original's rooms and answered as
 * if it had been there all along. Configuration is the only thing that should
 * travel; everything an agent has *lived* is keyed by its name and must stay
 * behind.
 *
 * So the reply reports both halves. What was copied, field by field, so the
 * clone can be seen to be faithful without running a diff — and what was
 * deliberately left, so nobody has to trust that it was.
 */

export const CLONE_AGENT_COMMAND_NAME = "clone-agent";

/** Most messages one clone will send. A rejected write is the only unbounded part of the reply. */
const MAX_CHUNKS = 3;

/**
 * Agent names end up as filesystem paths (`data/authored-resources/agent/<id>/`,
 * `data/context/agents/<id>/`) and as session-key fragments, so the set of
 * characters allowed here is deliberately narrower than YAML would accept.
 */
const VALID_AGENT_NAME = /^[A-Za-z0-9_-]+$/;

/** Where a definition was read from. Reported, because which one won is the whole of {@link CloneAgentDeps.lookupAgent}. */
export type AgentDefinitionOrigin = "registry" | "config";

export interface AgentDefinitionLookup {
  definition: AgentDefinition;
  origin: AgentDefinitionOrigin;
}

export interface CloneAgentDeps {
  /** The config-write choke point's host — `AgentRuntime` satisfies this structurally. */
  host: ConfigWriteHost;
  /**
   * Registry first, then `config.yaml` — the same precedence `resolveAgent`
   * uses, and it has to be. An agent migrated to
   * `data/authored-resources/agent/<id>/manifest.yaml` still has its old block
   * sitting in config.yaml; reading that block would clone whatever the agent
   * looked like before the migration, and the copy would be wrong in exactly
   * the way nobody checks — quietly, in fields that still parse.
   *
   * Used for the target too, so an existing name is refused whichever half of
   * the system holds it.
   */
  lookupAgent: (id: string) => AgentDefinitionLookup | undefined;
  /** Every agent that exists, for autocomplete and for naming them when the source is a typo. */
  listAgents: () => string[];
}

export function buildCloneAgentCommand(): SlashCommandBuilder {
  // Flat, not a subcommand of `/agent`: that command already carries a required
  // top-level `agent` option, and Discord rejects a command that has both
  // options and subcommands.
  const cmd = new SlashCommandBuilder()
    .setName(CLONE_AGENT_COMMAND_NAME)
    .setDescription("Copy an agent's configuration to a new name. Config only — no memory, sessions or rooms.");

  cmd.addStringOption((o) => o.setName("from").setDescription("Agent to copy").setRequired(true).setAutocomplete(true));
  cmd.addStringOption((o) =>
    o.setName("to").setDescription("Name for the copy (letters, digits, - and _)").setRequired(true),
  );

  return cmd as SlashCommandBuilder;
}

export function handleCloneAgentAutocomplete(interaction: AutocompleteInteraction, deps: CloneAgentDeps): void {
  if (interaction.commandName !== CLONE_AGENT_COMMAND_NAME) return;
  const focused = interaction.options.getFocused(true);
  // Only `from` completes. `to` is a name that does not exist yet, and offering
  // completions for it would suggest picking one that does.
  if (focused.name !== "from") return;
  const typed = String(focused.value ?? "").toLowerCase();
  const matches = deps
    .listAgents()
    .filter((v) => v.toLowerCase().includes(typed))
    .slice(0, 25);
  interaction.respond(matches.map((v) => ({ name: v, value: v }))).catch(() => {});
}

/**
 * Returns true when this interaction was `/clone-agent` and has been answered —
 * the caller should stop. Replies are ephemeral: the field summary can include
 * an agent's instructions length and provider, and more to the point a channel
 * does not need a running commentary on someone reorganising their agents.
 */
export async function handleCloneAgentCommand(
  interaction: ChatInputCommandInteraction,
  deps: CloneAgentDeps,
  _config: AgentConfig,
): Promise<boolean> {
  if (interaction.commandName !== CLONE_AGENT_COMMAND_NAME) return false;

  try {
    const all = splitMessage(await run(interaction, deps));
    const chunks = all.slice(0, MAX_CHUNKS);
    if (all.length > chunks.length) {
      chunks[chunks.length - 1] += `\n\n_…${all.length - chunks.length} more message(s) not shown._`;
    }
    await interaction.reply({ content: chunks[0], flags: MessageFlags.Ephemeral });
    for (const chunk of chunks.slice(1)) {
      await interaction.followUp({ content: chunk, flags: MessageFlags.Ephemeral });
    }
  } catch (err) {
    console.error("[discord] /clone-agent failed:", err);
    const message = `That didn't work: ${(err as Error).message}`;
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
  return true;
}

/**
 * What a field carries, in one line each.
 *
 * The point is that the clone can be checked without opening config.yaml, so
 * the long fields are described rather than printed: `instructions` is
 * routinely a few thousand characters and would push the interesting fields off
 * the end of the message.
 */
function summarizeValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value.length <= 60 ? `\`${value}\`` : `${value.length} chars`;
  if (typeof value === "number" || typeof value === "boolean") return `\`${value}\``;
  if (Array.isArray(value)) {
    const names = value.filter((v): v is string => typeof v === "string");
    if (names.length === value.length && value.length <= 8) return `${value.length} — ${names.join(", ")}`;
    return `${value.length} entr${value.length === 1 ? "y" : "ies"}`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    return `${keys.length} key(s): ${keys.join(", ")}`;
  }
  return String(value);
}

function describeCopied(definition: AgentDefinition): string {
  const entries = Object.entries(definition).filter(([, v]) => v !== undefined);
  if (entries.length === 0) {
    // Not an error: an agent can exist purely as a name that inherits every
    // default. Saying so beats an empty list that reads like a failed copy.
    return "It set no fields of its own — it ran entirely on the deployment defaults, and so does the copy.";
  }
  return entries.map(([k, v]) => `• \`${k}\`: ${summarizeValue(v)}`).join("\n");
}

/**
 * Everything keyed by agent name that this command does NOT touch.
 *
 * Listed explicitly in the reply rather than implied by silence. "I copied the
 * config" and "the clone is blank" are different claims, and only the second
 * one is what someone cloning an agent actually wants to know.
 */
const NOT_COPIED = [
  "• core memory — persona and every other section start empty",
  "• sessions and their history — it has never spoken to anyone",
  "• notes",
  "• room subscriptions — it is in no room, so nothing can wake it",
].join("\n");

async function run(interaction: ChatInputCommandInteraction, deps: CloneAgentDeps): Promise<string> {
  const from = (interaction.options.getString("from") ?? "").trim();
  const to = (interaction.options.getString("to") ?? "").trim();

  // Every refusal below happens before the write, so a rejected clone leaves
  // config.yaml exactly as it was.
  const source = deps.lookupAgent(from);
  if (!source) {
    return `No agent named **${from}**. Known: ${deps.listAgents().join(", ") || "(none)"}.`;
  }

  if (!VALID_AGENT_NAME.test(to)) {
    return (
      `**${to || "(empty)"}** is not a usable agent name — letters, digits, \`-\` and \`_\` only.\n` +
      "An agent's name becomes a directory under `data/authored-resources/agent/` and part of its session keys."
    );
  }

  const existing = deps.lookupAgent(to);
  if (existing) {
    return (
      `**${to}** already exists (defined in ${existing.origin === "registry" ? "authored resources" : "config.yaml"}). ` +
      "Cloning onto it would overwrite its configuration, so nothing was written. Pick another name."
    );
  }

  // Copied whole, minus the keys YAML would render as nulls. Nothing is renamed
  // or defaulted on the way through: a clone that quietly differs from its
  // source is worse than no clone at all.
  const definition: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source.definition)) {
    if (value !== undefined) definition[key] = structuredClone(value);
  }

  let warnings: string[];
  try {
    // Through the config-write choke point, which validates the result and
    // leaves the file untouched if the clone would introduce config that parses
    // but is never read.
    ({ warnings } = await updateRawConfig(deps.host, (raw) => {
      // `??=` rather than a truthiness check: a bare `agents:` key parses to
      // null, and assigning into null throws.
      const agents = (raw.agents ??= {}) as Record<string, unknown>;
      agents[to] = definition;
    }));
  } catch (err) {
    if (err instanceof ConfigWriteRejected) {
      return `Nothing was written — cloning **${from}** to **${to}** would have introduced config that is never read:\n- ${err.issues.join("\n- ")}`;
    }
    throw err;
  }

  const sourceNote =
    source.origin === "registry"
      ? "read from its authored-resource manifest (the definition the runtime actually resolves), not from config.yaml"
      : "read from its `config.yaml` block";

  const warningNote =
    warnings.length > 0 ? `\n\n**Warnings** (the write went through anyway):\n- ${warnings.join("\n- ")}` : "";

  // The restart claim is checked, not assumed: `updateRawConfig` reloads the
  // runtime, and `resolveAgent` falls back to `config.agents` when the registry
  // has no such id, so the clone resolves on the next turn. The registry itself
  // is only populated from disk in the AgentRuntime constructor, so the clone
  // stays in config.yaml until a restart migrates it into a manifest — which
  // changes nothing about whether it answers. Covered by
  // `clone-agent-command.test.ts` → "usable without a restart".
  return (
    `Cloned **${from}** → **${to}**, ${sourceNote}.\n\n` +
    `**Copied**\n${describeCopied(source.definition)}\n\n` +
    `**Not copied** — **${to}** is genuinely fresh:\n${NOT_COPIED}\n\n` +
    `**${to}** is usable right now — no restart needed. A restart will move it from config.yaml into its own ` +
    `authored-resource manifest, same as every other agent.${warningNote}`
  );
}
