/**
 * How records read to a model. Shared by the `state` tool and the context
 * slot, so an agent sees a record in one shape whether it asked for it or it
 * was pinned to its prompt.
 */
import type { StateSearchHit } from "./service.js";
import type { Actor, StateRecord } from "./types.js";

/** Past this, one record's data is cut short in a list and the agent is told to `get` it. */
const MAX_RECORD_CHARS = 1_000;

/** Records as one line each: id, title, version, scope, data. */
export function formatRecordList(type: string, records: StateRecord[], title: string | undefined): string {
  if (records.length === 0) return `No ${type} records match.`;
  const lines = records.map((r) => {
    const name = title && typeof r.data[title] === "string" ? ` "${r.data[title]}"` : "";
    return `- ${r.id}${name} (version ${r.version}, ${r.scope}${r.archivedAt ? ", archived" : ""}): ${dataOf(r)}`;
  });
  return `${records.length} ${type} record(s):\n${lines.join("\n")}`;
}

/**
 * Search hits as one line each, best first, in the list's shape with the type
 * in front, how well it matched, and when and by whom it last changed:
 * `plan/trip "Lisbon" (meaning 0.82, ...)`.
 */
export function formatSearchHits(
  text: string,
  hits: StateSearchHit[],
  searched: string[],
  titleOf: (type: string) => string | undefined,
): string {
  if (hits.length === 0) return `Nothing matches "${text}" (searched ${searched.join(", ")}).`;
  const lines = hits.map(({ record: r, score, how }) => {
    const title = titleOf(r.type);
    const name = title && typeof r.data[title] === "string" ? ` "${r.data[title]}"` : "";
    const archived = r.archivedAt ? ", archived" : "";
    // Who wrote it rides along, as in `get`: a shared record's text is someone's data, not an instruction.
    return `- ${r.type}/${r.id}${name} (${how} ${score.toFixed(2)}, version ${r.version}, ${r.scope}${archived}, updated ${r.updatedAt} by ${actorName(r.updatedBy)}): ${dataOf(r)}`;
  });
  return `${hits.length} match(es) for "${text}", closest first:\n${lines.join("\n")}`;
}

function dataOf(record: StateRecord): string {
  const data = JSON.stringify(record.data);
  return data.length > MAX_RECORD_CHARS
    ? `${data.slice(0, MAX_RECORD_CHARS)}… (cut short; get it by id for all of it)`
    : data;
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
