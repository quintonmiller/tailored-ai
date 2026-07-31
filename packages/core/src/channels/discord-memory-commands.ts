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
import { splitMessage } from "./split-message.js";

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

/**
 * Most messages one `show` will send. Core memory is capped at 8192 bytes when
 * rendered into a prompt, so five is comfortably more than a legitimate memory
 * needs — it exists so a pathological row cannot post forty messages.
 */
const MAX_CHUNKS = 5;

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

function isSection(value: string): value is CoreMemorySection {
  return (CORE_MEMORY_SECTIONS as string[]).includes(value);
}

function sectionList(): string {
  return CORE_MEMORY_SECTIONS.join(", ");
}

/**
 * Render in full. Splitting across messages is the caller's job.
 *
 * The first version clipped each section to 900 chars and the whole reply to
 * 1700, which made the command useless for the memories most worth reading: a
 * 2,328-char persona came back as a third of itself, and asking for that one
 * section did not help because the per-section clip applied either way. Core
 * memory is the text that shapes every one of an agent's turns — showing two
 * thirds of it is worse than not showing it, because it reads as complete.
 */
function renderRows(agent: string, rows: CoreMemoryRow[]): string {
  if (rows.length === 0) return `**${agent}** has no core memory. Sections it could have: ${sectionList()}.`;
  const parts = rows.map(
    (r) =>
      `__${r.section}__ · ${r.content.length} chars · last written by ${r.updated_by ?? "unknown"} ${r.updated_at}\n` +
      (r.content.trim() ? `\`\`\`\n${r.content}\n\`\`\`` : "_(empty)_"),
  );
  return `**${agent}** core memory\n\n${parts.join("\n\n")}`;
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
    // Sent across as many messages as it takes. A section can legitimately run
    // past Discord's 2,000-char ceiling, and the whole point of reading core
    // memory is seeing all of it.
    const all = splitMessage(run(interaction, deps));
    const chunks = all.slice(0, MAX_CHUNKS);
    // Said out loud. Dropping the tail quietly is the failure this change
    // exists to undo — a partial answer that reads as a complete one.
    if (all.length > chunks.length) {
      chunks[chunks.length - 1] +=
        "\n\n_…" + (all.length - chunks.length) + " more message(s) not shown. Ask for one `section:` at a time._";
    }
    await interaction.reply({ content: chunks[0], flags: MessageFlags.Ephemeral });
    for (const chunk of chunks.slice(1)) {
      await interaction.followUp({ content: chunk, flags: MessageFlags.Ephemeral });
    }
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
  const recoverable = before.trim() ? `\n\nWhat was there before:\n\`\`\`\n${before}\n\`\`\`` : "";

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
