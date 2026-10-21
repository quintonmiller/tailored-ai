/**
 * How records read to a model. Shared by the `state` tool and the context
 * slot, so an agent sees a record in one shape whether it asked for it or it
 * was pinned to its prompt.
 */
import type { Actor, StateRecord } from "./types.js";

/** Past this, one record's data is cut short in a list and the agent is told to `get` it. */
const MAX_RECORD_CHARS = 1_000;

/** Records as one line each: id, title, version, scope, data. */
export function formatRecordList(type: string, records: StateRecord[], title: string | undefined): string {
  if (records.length === 0) return `No ${type} records match.`;
  const lines = records.map((r) => {
    const name = title && typeof r.data[title] === "string" ? ` "${r.data[title]}"` : "";
    let data = JSON.stringify(r.data);
    if (data.length > MAX_RECORD_CHARS)
      data = `${data.slice(0, MAX_RECORD_CHARS)}… (cut short; get it by id for all of it)`;
    return `- ${r.id}${name} (version ${r.version}, ${r.scope}${r.archivedAt ? ", archived" : ""}): ${data}`;
  });
  return `${records.length} ${type} record(s):\n${lines.join("\n")}`;
}

/** Who made a change, in a word: an agent by name, anyone else by kind. */
export function actorName(actor: Actor): string {
  return actor.kind === "agent" ? actor.name : actor.kind;
}

/** When an archived record was archived, by whom and why, as one sentence. Empty for a live record. */
export function archivedLine(record: StateRecord): string {
  if (!record.archivedAt) return "";
  const by = record.archivedBy ? ` by ${actorName(record.archivedBy)}` : "";
  const reason = record.archiveReason;
  return `Archived ${record.archivedAt}${by}${reason ? `: ${reason}${/[.!?]$/.test(reason) ? "" : "."}` : "."}`;
}

/** `field` sorts ascending, `-field` descending; anything else leaves the provider's default. */
export function parseOrderBy(value: unknown): { orderBy?: { field: string; direction: "asc" | "desc" } } {
  if (typeof value !== "string" || !value.trim()) return {};
  const raw = value.trim();
  return raw.startsWith("-")
    ? { orderBy: { field: raw.slice(1), direction: "desc" } }
    : { orderBy: { field: raw, direction: "asc" } };
}
