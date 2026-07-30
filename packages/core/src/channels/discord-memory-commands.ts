import {
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  MessageFlags,
  SlashCommandBuilder,
} from "discord.js";
import type { AgentConfig } from "../config.js";
import {
  appendCoreMemory,
  CORE_MEMORY_SECTIONS,
  type CoreMemoryRow,
  type CoreMemorySection,
  clearCoreMemorySection,
  getCoreMemory,
  getCoreMemorySection,
  setCoreMemory,
} from "../db/core-memory-queries.js";

/**
 * `/memory` — read and edit what an agent remembers about itself.
 *
 * Core memory is the one store that is per-agent, survives every session, and
 * goes into the system prompt on every single turn. Until now the only writer
 * was the agent itself, through the `core_memory` tool, and there was no reader
 * at all outside the database: an agent could write itself a persona that
 * shaped every later answer and nobody could see it, let alone correct it.
 *
 * That asymmetry is the point of this command. Sessions can be reset and
 * rewound; core memory could only be changed by asking the agent nicely.
 */

export const MEMORY_COMMAND_NAME = "memory";

/** Discord hard-caps a message at 2000; leave room for the framing around the content. */
const MAX_BODY = 1700;

export interface MemoryCommandDeps {
  db: import("better-sqlite3").Database;
  /** Agents that exist, for autocomplete and for rejecting typos before they write. */
  listAgents: () => string[];
}

export function buildMemoryCommand(): SlashCommandBuilder {
  const cmd = new SlashCommandBuilder()
    .setName(MEMORY_COMMAND_NAME)
    .setDescription("Read or edit what an agent remembers about itself");

  cmd.addSubcommand((s) =>
    s
      .setName("show")
      .setDescription("Read an agent's core memory")
      .addStringOption((o) => o.setName("agent").setDescription("Which agent").setRequired(true).setAutocomplete(true))
      .addStringOption((o) =>
        o.setName("section").setDescription("One section. Omit for all.").setRequired(false).setAutocomplete(true),
      ),
  );

  cmd.addSubcommand((s) =>
    s
      .setName("set")
      .setDescription("Replace a section. The old text comes back in the reply so you can put it back.")
      .addStringOption((o) => o.setName("agent").setDescription("Which agent").setRequired(true).setAutocomplete(true))
      .addStringOption((o) =>
        o.setName("section").setDescription("Which section").setRequired(true).setAutocomplete(true),
      )
      .addStringOption((o) => o.setName("content").setDescription("New content").setRequired(true)),
  );

  cmd.addSubcommand((s) =>
    s
      .setName("append")
      .setDescription("Add a line to a section")
      .addStringOption((o) => o.setName("agent").setDescription("Which agent").setRequired(true).setAutocomplete(true))
      .addStringOption((o) =>
        o.setName("section").setDescription("Which section").setRequired(true).setAutocomplete(true),
      )
      .addStringOption((o) => o.setName("content").setDescription("Line to add").setRequired(true)),
  );

  cmd.addSubcommand((s) =>
    s
      .setName("clear")
      .setDescription("Empty a section. The old text comes back in the reply so you can put it back.")
      .addStringOption((o) => o.setName("agent").setDescription("Which agent").setRequired(true).setAutocomplete(true))
      .addStringOption((o) =>
        o.setName("section").setDescription("Which section").setRequired(true).setAutocomplete(true),
      ),
  );

  return cmd;
}

/** Clip to something Discord will accept, saying so rather than truncating silently. */
function clip(text: string, limit = MAX_BODY): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [${text.length - limit} more chars — the full text is in core memory]`;
}

function isSection(value: string): value is CoreMemorySection {
  return (CORE_MEMORY_SECTIONS as string[]).includes(value);
}

function sectionList(): string {
  return CORE_MEMORY_SECTIONS.join(", ");
}

function renderRows(agent: string, rows: CoreMemoryRow[]): string {
  if (rows.length === 0) return `**${agent}** has no core memory. Sections it could have: ${sectionList()}.`;
  const parts = rows.map(
    (r) =>
      `__${r.section}__ · ${r.content.length} chars · last written by ${r.updated_by ?? "unknown"} ${r.updated_at}\n` +
      (r.content.trim() ? `\`\`\`\n${clip(r.content, 900)}\n\`\`\`` : "_(empty)_"),
  );
  return `**${agent}** core memory\n\n${clip(parts.join("\n\n"))}`;
}

export function handleMemoryAutocomplete(interaction: AutocompleteInteraction, deps: MemoryCommandDeps): void {
  if (interaction.commandName !== MEMORY_COMMAND_NAME) return;
  const focused = interaction.options.getFocused(true);
  const typed = String(focused.value ?? "").toLowerCase();

  const pool =
    focused.name === "section"
      ? (CORE_MEMORY_SECTIONS as readonly string[])
      : focused.name === "agent"
        ? deps.listAgents()
        : [];

  const matches = pool.filter((v) => v.toLowerCase().includes(typed)).slice(0, 25);
  interaction.respond(matches.map((v) => ({ name: v, value: v }))).catch(() => {});
}

/**
 * Returns true when this interaction was a `/memory` command and has been
 * answered — the caller should stop. Replies are ephemeral: core memory can
 * carry a persona written in the first person and a channel is the wrong place
 * to print it.
 */
export async function handleMemoryCommand(
  interaction: ChatInputCommandInteraction,
  deps: MemoryCommandDeps,
  _config: AgentConfig,
): Promise<boolean> {
  if (interaction.commandName !== MEMORY_COMMAND_NAME) return false;

  try {
    await interaction.reply({ content: run(interaction, deps), flags: MessageFlags.Ephemeral });
  } catch (err) {
    console.error("[discord] /memory failed:", err);
    const message = `That didn't work: ${(err as Error).message}`;
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    } else {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
  return true;
}

function run(interaction: ChatInputCommandInteraction, deps: MemoryCommandDeps): string {
  const sub = interaction.options.getSubcommand();
  const agent = (interaction.options.getString("agent") ?? "").trim();

  const known = deps.listAgents();
  if (!known.includes(agent)) {
    // Checked before any write: a typo would otherwise create core memory for
    // an agent that does not exist, which nothing would ever read.
    return `No agent named **${agent}**. Known: ${known.join(", ") || "(none)"}.`;
  }

  const scope = { agent, project_id: null };

  if (sub === "show") {
    const wanted = interaction.options.getString("section");
    if (wanted !== null && !isSection(wanted)) return `"${wanted}" is not a section. Sections: ${sectionList()}.`;
    const rows =
      wanted === null
        ? getCoreMemory(deps.db, scope)
        : [getCoreMemorySection(deps.db, scope, wanted)].filter((r): r is CoreMemoryRow => !!r);
    return renderRows(agent, rows);
  }

  const sectionRaw = (interaction.options.getString("section") ?? "").trim();
  if (!isSection(sectionRaw)) return `"${sectionRaw}" is not a section. Sections: ${sectionList()}.`;
  const section = sectionRaw;
  const before = getCoreMemorySection(deps.db, scope, section)?.content ?? "";

  // The previous text comes back in every reply that destroys some. Core
  // memory has no history table, so without this an overwrite is unrecoverable
  // — the same reason `/room rewind` hides rather than deletes.
  const recoverable = before.trim() ? `\n\nWhat was there before:\n\`\`\`\n${clip(before, 1200)}\n\`\`\`` : "";

  switch (sub) {
    case "set": {
      const content = interaction.options.getString("content") ?? "";
      setCoreMemory(deps.db, { ...scope, section, content, updated_by: interaction.user.username });
      return `Set **${agent}** / __${section}__ (${content.length} chars). Takes effect on its next turn.${recoverable}`;
    }
    case "append": {
      const content = interaction.options.getString("content") ?? "";
      const row = appendCoreMemory(deps.db, {
        ...scope,
        section,
        item: content,
        updated_by: interaction.user.username,
      });
      return `Added to **${agent}** / __${section}__ — now ${row.content.length} chars. Takes effect on its next turn.`;
    }
    case "clear": {
      if (!before.trim()) return `**${agent}** / __${section}__ was already empty.`;
      clearCoreMemorySection(deps.db, scope, section);
      return `Cleared **${agent}** / __${section}__.${recoverable}`;
    }
    default:
      return `Unknown subcommand "${sub}".`;
  }
}
