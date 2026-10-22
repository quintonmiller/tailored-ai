/**
 * What an agent's page shows, worked out from the directory's records: which
 * sections, in what order, and which commitments go in each.
 *
 * The section ids and the order rule mirror the directory plugin's
 * (`directory-tools.ts`, `pageOrder`), because the agent arranges its page by
 * those ids with the `directory` tool and reads the result back from there.
 * This package takes no TAI dependency, so they are copied rather than
 * imported, as `content.ts` copies the content types.
 */
import type { StateRecordInfo } from "../api";

/** The sections every page starts with, in order, and their headings. */
export const PAGE_SECTIONS: Record<string, string> = {
  about: "What I'm for",
  working: "Working on",
  waiting: "Waiting on you",
  results: "Recent results",
  docs: "Docs",
  misses: "Questions nobody could answer",
};

/** How far back "recent" reaches, for results and misses. */
export const RECENT_DAYS = 14;

/** A section the agent added: a titled list of the records its query matches. */
export interface PageSection {
  id: string;
  title: string;
  query: { type: string; where?: Record<string, unknown>; orderBy?: string; limit?: number; scopes?: string[] };
}

/** The sections a page record holds, leaving out any a hand edit left unusable. */
export function pageSections(data: Record<string, unknown> | undefined): PageSection[] {
  const extra = data?.extra;
  if (!Array.isArray(extra)) return [];
  return extra.filter(
    (x): x is PageSection =>
      !!x &&
      typeof x === "object" &&
      typeof (x as PageSection).id === "string" &&
      typeof (x as PageSection).title === "string" &&
      typeof (x as PageSection).query?.type === "string",
  );
}

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** The ids of the sections to draw, in order: the ones the page names first, then the rest, less the hidden. */
export function pageOrder(data: Record<string, unknown> | undefined): string[] {
  const all = [...Object.keys(PAGE_SECTIONS), ...pageSections(data).map((x) => x.id)];
  const order = ids(data?.order).filter((id) => all.includes(id));
  const hide = new Set(ids(data?.hide));
  return [...order, ...all.filter((id) => !order.includes(id))].filter((id) => !hide.has(id));
}

/** When a commitment last moved: its newest update, or the record's last change. */
export function lastMoved(record: StateRecordInfo): string {
  const updates = record.data.updates;
  const newest = Array.isArray(updates) ? (updates[0] as { at?: unknown } | undefined) : undefined;
  return typeof newest?.at === "string" ? newest.at : record.updatedAt;
}

/** A commitment's dated updates, newest first, as the record keeps them. `by` says who wrote one, on a room's. */
export function updatesOf(record: StateRecordInfo): { at: string; text: string; by?: string }[] {
  const updates = record.data.updates;
  if (!Array.isArray(updates)) return [];
  return updates
    .filter(
      (u): u is { at: string; text: string; by?: unknown } =>
        !!u && typeof (u as { at?: unknown }).at === "string" && typeof (u as { text?: unknown }).text === "string",
    )
    .map((u) => ({ at: u.at, text: u.text, ...(typeof u.by === "string" && u.by ? { by: u.by } : {}) }));
}

/**
 * An agent's commitments by section: open ones it's working on, the ones
 * waiting, and the ones it finished in the last fortnight. Each most recently
 * moved first.
 */
export function groupCommitments(records: StateRecordInfo[], now: Date) {
  const newest = (a: StateRecordInfo, b: StateRecordInfo) => lastMoved(b).localeCompare(lastMoved(a));
  const since = now.getTime() - RECENT_DAYS * 86_400_000;
  const live = records.filter((r) => !r.archivedAt);
  return {
    working: live.filter((r) => r.data.status === "open").sort(newest),
    waiting: live.filter((r) => r.data.status === "waiting").sort(newest),
    results: live.filter((r) => r.data.status === "done" && Date.parse(lastMoved(r)) >= since).sort(newest),
  };
}

/** Misses in the last fortnight, newest first. */
export function recentMisses(records: StateRecordInfo[], now: Date): StateRecordInfo[] {
  const since = now.getTime() - RECENT_DAYS * 86_400_000;
  const at = (r: StateRecordInfo) => (typeof r.data.at === "string" ? r.data.at : r.createdAt);
  return records.filter((r) => !r.archivedAt && Date.parse(at(r)) >= since).sort((a, b) => at(b).localeCompare(at(a)));
}

/** A commitment's progress: a count to draw as a bar, a step label, or nothing. */
export function progressOf(value: unknown): { value: number; max: number } | { label: string } | undefined {
  if (typeof value === "string") return value.trim() ? { label: value.trim() } : undefined;
  if (!value || typeof value !== "object") return undefined;
  const { value: v, max } = value as Record<string, unknown>;
  return typeof v === "number" && typeof max === "number" && max > 0 ? { value: v, max } : undefined;
}

/** How much an agent may do on its own about a commitment, in a person's words. */
export const AUTONOMY: Record<string, string> = {
  suggest: "asks first",
  tell: "acts, then tells you",
  quiet: "acts quietly",
};

const UPKEEP_KINDS = ["archived", "reviewed", "updated", "closed"] as const;
type UpkeepKind = (typeof UPKEEP_KINDS)[number];

/**
 * What an upkeep turn changed, in a few words: "archived 2, reviewed 1", or
 * "changed nothing". Undefined when nothing was counted.
 */
export function upkeepChanges(changed: Partial<Record<UpkeepKind, number>> | undefined): string | undefined {
  if (!changed) return undefined;
  const parts = UPKEEP_KINDS.filter((k) => (changed[k] ?? 0) > 0).map((k) => `${k} ${changed[k]}`);
  return parts.length ? parts.join(", ") : "changed nothing";
}

/** "just now", "5m ago", "3h ago", "2d ago". */
export function ago(iso: string | undefined, now = new Date()): string {
  if (!iso) return "";
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** "Oct 19", or "Oct 19, 2025" outside this year. */
export function day(iso: string | undefined, now = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}
