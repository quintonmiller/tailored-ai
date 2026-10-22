/**
 * Upkeep: now and then, an agent looks after what it owns. Its commitments,
 * its docs, its page and its notes are counted for what needs a look (a check
 * that came due, work waiting too long, a doc nobody has reviewed, a note
 * nobody recalls), and the agent gets one message with that evidence and an
 * invitation to tidy with the tools it already has. See `docs/directory.md`
 * and the design in `docs/ownership-design.md`.
 *
 * Off unless asked for, in the directory plugin's config:
 *
 * ```yaml
 * plugins:
 *   - module: builtin:directory
 *     config:
 *       upkeep: { every: 24h, agents: all }   # or agents: [planner, writer]
 * ```
 *
 * It runs on the places plugin's tend timing (`places-tend.ts`): each agent's
 * turn comes round once every `every` at a time its name sets, one turn runs
 * at a time, and a turn that comes round while agents are paused or the agent
 * is switched off is skipped, not saved up. A turn whose evidence is the same
 * as when the agent's last upkeep finished is skipped too: nothing changed.
 *
 * An agent that leads a room looks after the room's records in the same
 * turn, under a section of their own, by the same rules.
 *
 * The turn runs in the agent's own `upkeep:<agent>` session through
 * `runtime.wakeAgent`, with a small budget of tool rounds, so it counts toward
 * the agent's hourly wake ceiling like any turn nobody asked for. What it
 * changed is counted afterwards from the history of the agent's records, never
 * from what the agent says it did, and kept in its `upkeep` record for its page.
 */
import { isDeepStrictEqual } from "node:util";
import { pinnedLoad } from "../agent/memory-inject.js";
import type { WakeOutcome } from "../agent/wake.js";
import type { MemoryBackend, MemoryFragment } from "../memory/interface.js";
import { memoryScope } from "../memory/scope.js";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { within, wordsOf } from "../state/search.js";
import { type StateChange, StateError, type StateRecord } from "../state/types.js";
import {
  ACTIVE,
  COMMITMENT_TYPE,
  type Directory,
  DOC_TYPE,
  lastUpdate,
  MISS_TYPE,
  PAGE_TYPE,
  PERSON,
  PROFILE_TYPE,
  readsOf,
  stringList,
  titleOf,
  UPKEEP_SESSIONS,
} from "./directory-records.js";
import { type RoomInfo, roomOwner } from "./directory-rooms.js";
import { parseTend, parseTime, REFUSED_WORDS, type TendSettings, type TurnOutcome } from "./places-tend.js";

/** Upkeep as configured: when it runs by itself, and the bars its evidence is counted against. */
export interface UpkeepSettings {
  /** When each agent's upkeep comes round, and for whom. Absent, it runs only when a person asks. */
  schedule?: TendSettings;
  /** Rounds of tool calls an upkeep turn may take. */
  maxRounds: number;
  /** Tokens that pinned notes and core memory, loaded every turn, should keep under. */
  memoryBudget: number;
  /** Days before each kind of evidence counts. */
  days: UpkeepDays;
}

export interface UpkeepDays {
  /** A commitment waiting this long. */
  waiting: number;
  /** A commitment in hand with no update this long. */
  quiet: number;
  /** A commitment done or dropped this long ago and still not archived. */
  finished: number;
  /** A doc not reviewed this long. */
  review: number;
  /** A note not recalled this long. */
  recall: number;
  /** A note that expires within this long. */
  expiring: number;
}

/** Every default upkeep has, in one place: the config keys it reads, and what each is when left out. */
export const UPKEEP_DEFAULTS = {
  maxRounds: 6,
  memoryBudget: 1_500,
  waitingDays: 7,
  quietDays: 14,
  archiveAfterDays: 7,
  reviewDays: 30,
  recallDays: 30,
  expiringDays: 3,
} as const;

/** The most rounds an upkeep turn may be given: it is for tidying, not for work. */
const MAX_ROUNDS_CEILING = 20;

/**
 * The plugin config's `upkeep`, read: the schedule when `every` and `agents`
 * are given, and every bar, with anything unusable replaced by its default.
 * `warn` hears each problem once, in words for the log.
 */
export function parseUpkeep(raw: unknown, warn: (problem: string) => void): UpkeepSettings {
  const bag = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  if (raw !== undefined && raw !== null && raw !== false && bag !== raw) {
    warn('upkeep is { every: "24h", agents: [names] | "all" }, with optional bars; it is off.');
  }
  const number = (key: keyof typeof UPKEEP_DEFAULTS, min: number, max = Number.POSITIVE_INFINITY): number => {
    const value = bag[key];
    const fallback = UPKEEP_DEFAULTS[key];
    if (value === undefined) return fallback;
    if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max) return value;
    warn(
      `upkeep.${key} should be a number from ${min}${max < Number.POSITIVE_INFINITY ? ` to ${max}` : " up"}; using ${fallback}.`,
    );
    return fallback;
  };
  let schedule: TendSettings | undefined;
  if (bag.every !== undefined || bag.agents !== undefined) {
    const parsed = parseTend({ every: bag.every, agents: bag.agents }, "upkeep");
    if (typeof parsed === "string") warn(`upkeep won't run by itself: ${parsed}`);
    else schedule = parsed;
  }
  return {
    ...(schedule ? { schedule } : {}),
    maxRounds: Math.floor(number("maxRounds", 1, MAX_ROUNDS_CEILING)),
    memoryBudget: number("memoryBudget", 0),
    days: {
      waiting: number("waitingDays", 0),
      quiet: number("quietDays", 0),
      finished: number("archiveAfterDays", 0),
      review: number("reviewDays", 0),
      recall: number("recallDays", 0),
      expiring: number("expiringDays", 0),
    },
  };
}

// --------------------------------------------------------------------------
// Evidence
// --------------------------------------------------------------------------

/**
 * One thing upkeep found, as a line for the agent and the keys that say what
 * it is. The keys name the record and the rule, never a count of days, so
 * evidence that only got older reads as unchanged.
 */
export interface Item {
  keys: string[];
  line: string;
}

/** Evidence of one kind, under a heading. Empty sections are left out of the message. */
export interface Section {
  title: string;
  items: Item[];
}

const DAY_MS = 86_400_000;
/** Lines one section shows before counting the rest. */
const SECTION_SHOWN = 8;
const CLIP = 80;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const clip = (s: string) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > CLIP ? `${one.slice(0, CLIP - 1)}…` : one;
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (items: string[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : (items[0] ?? "");

/** Whole days from `at` to `now`; undefined for a time that can't be read. */
export function daysSince(at: string | undefined, now: Date): number | undefined {
  if (!at) return undefined;
  const then = parseTime(at);
  return Number.isFinite(then) ? Math.floor((now.getTime() - then) / DAY_MS) : undefined;
}

const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;
const DATE_DAY = String.raw`(\d{1,2})(?:st|nd|rd|th)?`;
const YEAR = String.raw`((?:19|20)\d{2})`;
/** "Oct 25, 2026", "October 25th 2026". */
const MONTH_FIRST = new RegExp(String.raw`\b${MONTH}\s+${DATE_DAY},?\s+${YEAR}\b`, "i");
/** "25 Oct 2026", "25th of October, 2026". */
const DAY_FIRST = new RegExp(String.raw`\b${DATE_DAY}\s+(?:of\s+)?${MONTH},?\s+${YEAR}\b`, "i");
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * When a commitment's `nextCheck` falls, when it reads as a date: an ISO date
 * (with a time or without) anywhere in it, or a month named with its day and
 * year, like "Oct 25, 2026" or "25 October 2026". "Friday", "end of 2026" or
 * "when the hotel replies in 2026" read as no date, and count for nothing:
 * the clock's own reading of free text turns any year into 1 January.
 */
export function checkDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const iso = /\b(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?)(Z|[+-]\d{2}:?\d{2})?)?\b/.exec(value);
  if (iso) {
    const at = Date.parse(iso[2] ? `${iso[1]}T${iso[2]}${iso[3] ?? ""}` : iso[1]);
    return Number.isFinite(at) ? at : undefined;
  }
  const monthFirst = MONTH_FIRST.exec(value);
  const dayFirst = monthFirst ? undefined : DAY_FIRST.exec(value);
  const [month, day, year] = monthFirst
    ? [monthFirst[1], monthFirst[2], monthFirst[3]]
    : dayFirst
      ? [dayFirst[2], dayFirst[1], dayFirst[3]]
      : [];
  if (!month || !day || !year) return undefined;
  // Midnight UTC, as an ISO date with no time reads. A day the month doesn't have, like 31 June, is no date.
  const m = MONTHS.indexOf(month.slice(0, 3).toLowerCase());
  const at = Date.UTC(Number(year), m, Number(day));
  return new Date(at).getUTCDate() === Number(day) ? at : undefined;
}

const CLOSED: readonly string[] = ["done", "dropped"];

/**
 * Commitments that need a look: a next check that came due, waiting for
 * `days.waiting` or more, no update for `days.quiet` or more, and done or
 * dropped `days.finished` or more ago without being archived. One line per
 * commitment, with every reason it has. `waitingSince` says when each waiting
 * one started waiting, where its history could tell; otherwise its last update
 * stands in.
 */
export function commitmentItems(
  records: StateRecord[],
  now: Date,
  days: UpkeepDays,
  waitingSince: Map<string, string> = new Map(),
): Item[] {
  const items: Item[] = [];
  for (const r of records) {
    if (r.archivedAt) continue;
    const status = String(r.data.status ?? "open");
    const keys: string[] = [];
    const reasons: string[] = [];
    const add = (rule: string, reason: string) => {
      keys.push(`commitment:${r.id}:${rule}`);
      reasons.push(reason);
    };
    const moved = daysSince(lastUpdate(r), now);
    if ((ACTIVE as readonly string[]).includes(status)) {
      const check = text(r.data.nextCheck);
      const due = checkDate(check);
      if (due !== undefined && due <= now.getTime()) add("check", `its next check, ${check}, has come`);
      if (status === "waiting") {
        const waited = daysSince(waitingSince.get(r.id) ?? lastUpdate(r), now);
        const on = text(r.data.waitingOn);
        if (waited !== undefined && waited >= days.waiting) {
          add("waiting", `waiting${on ? ` on ${clip(on)}` : ""} for ${plural(waited, "day")}`);
        }
      }
      if (moved !== undefined && moved >= days.quiet) add("quiet", `no update in ${plural(moved, "day")}`);
    } else if (CLOSED.includes(status) && moved !== undefined && moved >= days.finished) {
      add("finished", `${status} ${plural(moved, "day")} ago and still not archived`);
    }
    if (reasons.length) items.push({ keys, line: `- ${r.id} "${clip(titleOf(r) ?? "")}": ${reasons.join("; ")}` });
  }
  return items;
}

/**
 * Docs that need a look, and what others made of them: not reviewed for
 * `days.review` or more, read by other agents since the last upkeep (counted
 * against `readsAtLast`), and searches in the agent's area that found nothing.
 * `first` is an agent's first upkeep, whose reads are all there have been.
 */
export function docItems(at: {
  docs: StateRecord[];
  misses: StateRecord[];
  reads: ReturnType<typeof readsOf>;
  readsAtLast: Record<string, number>;
  now: Date;
  days: UpkeepDays;
  first: boolean;
  /** Whose area the misses are in, in words: "your" by default, or a room's. */
  area?: string;
}): Item[] {
  const items: Item[] = [];
  for (const d of at.docs) {
    if (d.archivedAt) continue;
    const reasons: string[] = [];
    const keys: string[] = [];
    const reviewedAt = text(d.data.reviewedAt);
    const unreviewed = daysSince(reviewedAt ?? d.createdAt, at.now);
    if (unreviewed !== undefined && unreviewed >= at.days.review) {
      keys.push(`doc:${d.id}:review`);
      reasons.push(
        reviewedAt
          ? `not reviewed in ${plural(unreviewed, "day")}`
          : `never reviewed, written ${plural(unreviewed, "day")} ago`,
      );
    }
    const reads = at.reads[d.id];
    const fresh = reads ? reads.n - (at.readsAtLast[d.id] ?? 0) : 0;
    if (reads && fresh > 0) {
      keys.push(`doc:${d.id}:read`);
      const lately = reads.by.length ? `, lately by ${list(reads.by)}` : "";
      reasons.push(
        `read ${plural(fresh, "time")} by other agents ${at.first ? "so far" : "since your last upkeep"}${lately}`,
      );
    }
    if (reasons.length) items.push({ keys, line: `- ${d.id} "${clip(titleOf(d) ?? "")}": ${reasons.join("; ")}` });
  }
  for (const m of at.misses) {
    if (m.archivedAt) continue;
    const askedBy = stringList(m.data.askedBy) ?? [];
    items.push({
      keys: [`miss:${m.id}`],
      line: `- Looked for in ${at.area ?? "your"} area, with no doc or commitment to find: "${clip(text(m.data.query) ?? "")}"${askedBy.length ? `, asked by ${list(askedBy)}` : ""}`,
    });
  }
  return items;
}

/**
 * The agent's page: no note for people, or a note written before its newest
 * work (a commitment or doc it took on or wrote, or a commitment it finished).
 * For a room's page, `room` names it, and `page` is the room's profile, which
 * holds its note.
 */
export function pageItems(page: StateRecord | null, work: StateRecord[], now: Date, room?: RoomInfo): Item[] {
  const key = room ? `page:${roomOwner(room.ref)}` : "page";
  const note = text(page?.data.note);
  if (!page || !note) {
    return [
      {
        keys: [`${key}:note`],
        line: room ? `- The ${room.name} room's page has no note for people.` : "- Your page has no note for people.",
      },
    ];
  }
  const noteAt = parseTime(text(page.data.noteAt) ?? page.updatedAt);
  let newest: { at: number; record: StateRecord } | undefined;
  for (const r of work) {
    if (r.archivedAt) continue;
    const times = [parseTime(r.createdAt)];
    if (r.type === COMMITMENT_TYPE && r.data.status === "done") times.push(parseTime(lastUpdate(r)));
    for (const at of times) if (Number.isFinite(at) && (!newest || at > newest.at)) newest = { at, record: r };
  }
  if (!newest || !Number.isFinite(noteAt) || newest.at <= noteAt) return [];
  const ago = daysSince(new Date(newest.at).toISOString(), now) ?? 0;
  const when = ago === 0 ? "today" : `${plural(ago, "day")} ago`;
  return [
    {
      keys: [`${key}:old:${newest.record.id}`],
      line: `- ${room ? `The ${room.name} room's page note was written before its` : "Your page note was written before your"} newest work: ${newest.record.type} ${newest.record.id} "${clip(titleOf(newest.record) ?? "")}", ${when}.`,
    },
  ];
}

/** A note as upkeep reads it from the memory store. */
export interface NoteView {
  id: string;
  text: string;
  createdAt?: string;
  recalledAt?: string;
  refCount: number;
  ttlAt?: string;
  kept: boolean;
  pinned: boolean;
}

/** A note from a memory fragment; undefined for one that isn't a live note of `agent`'s. */
export function noteOf(f: MemoryFragment, agent: string): NoteView | undefined {
  const md = f.metadata ?? {};
  if (!f.id || md.archived_at || (md.kind !== undefined && md.kind !== "note")) return undefined;
  if (md.agent !== agent) return undefined;
  const tags = Array.isArray(md.tags) ? md.tags : [];
  return {
    id: f.id,
    text: f.text,
    ...(text(md.created_at) ? { createdAt: text(md.created_at) } : {}),
    ...(text(md.recalled_at) ? { recalledAt: text(md.recalled_at) } : {}),
    refCount: typeof md.ref_count === "number" ? md.ref_count : 0,
    ...(text(md.ttl_at) ? { ttlAt: text(md.ttl_at) } : {}),
    kept: md.kept === true,
    pinned: md.pinned === true || tags.includes("pinned"),
  };
}

/** The key of the evidence that what loads every turn is over its budget. */
const LOADED = "note:loaded";
/** How the key of a pair of notes that look like one ends. */
const PAIR_KEY = ":same";

/** Pairs of notes that look like one note, by the share of words they have in common. */
const SAME_WORDS = 0.7;
/** Pairs of notes that look like one note, by the similarity of their meaning. */
const SAME_MEANING = 0.92;
/** Fewer words than this and word overlap says little. */
const MIN_WORDS = 3;
/** Pairs shown. */
const PAIRS_SHOWN = 5;

/**
 * Notes that look like the same note: pairs whose words mostly overlap, or,
 * when `vectors` are given (the embedder answered), whose meanings are nearly
 * the same. Best pairs first.
 */
export function duplicatePairs(notes: NoteView[], vectors?: Map<string, Float32Array>): [NoteView, NoteView][] {
  const words = new Map(notes.map((n) => [n.id, new Set(wordsOf(n.text))]));
  const scored: { a: NoteView; b: NoteView; score: number }[] = [];
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      const a = notes[i];
      const b = notes[j];
      const wa = words.get(a.id) as Set<string>;
      const wb = words.get(b.id) as Set<string>;
      let score = 0;
      if (wa.size >= MIN_WORDS && wb.size >= MIN_WORDS) {
        let shared = 0;
        for (const w of wa) if (wb.has(w)) shared++;
        const overlap = shared / (wa.size + wb.size - shared);
        if (overlap >= SAME_WORDS) score = overlap;
      }
      const va = vectors?.get(a.id);
      const vb = vectors?.get(b.id);
      if (va && vb) {
        const similarity = cosine(va, vb);
        if (similarity >= SAME_MEANING) score = Math.max(score, similarity);
      }
      if (score > 0) scored.push({ a, b, score });
    }
  }
  return scored.sort((x, y) => y.score - x.score).map((p) => [p.a, p.b]);
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/**
 * The agent's own notes: live ones not recalled for `days.recall` or more
 * (pinned and kept ones aside: they are meant to stay), pairs that look like
 * the same note, notes that expire within `days.expiring`, the size of what
 * loads every turn against the budget, and pinned notes that don't fit in it
 * and so never load. A note recalled before recall times were kept, and
 * never since, has no time to go by and is left out.
 */
export function noteItems(at: {
  notes: NoteView[];
  pairs: [NoteView, NoteView][];
  now: Date;
  days: UpkeepDays;
  loaded?: { tokens: number; budget: number };
  coreMemory?: boolean;
  /** Pinned notes that don't fit in what loads every turn, by id, and how many do. */
  unloaded?: { ids: string[]; fit: number };
}): Item[] {
  const items: Item[] = [];
  const quote = (n: NoteView) => `${n.id} "${clip(n.text)}"`;
  for (const n of at.notes) {
    if (n.pinned || n.kept) continue;
    const last = n.recalledAt ?? (n.refCount === 0 ? n.createdAt : undefined);
    const idle = daysSince(last, at.now);
    if (idle !== undefined && idle >= at.days.recall) {
      items.push({
        keys: [`note:${n.id}:recall`],
        line: `- ${quote(n)}: ${n.recalledAt ? `not recalled in ${plural(idle, "day")}` : `never recalled, written ${plural(idle, "day")} ago`}`,
      });
    }
  }
  for (const [a, b] of at.pairs.slice(0, PAIRS_SHOWN)) {
    items.push({
      keys: [`note:${a.id}+${b.id}${PAIR_KEY}`],
      line: `- ${quote(a)} and ${quote(b)} look like the same note`,
    });
  }
  for (const n of at.notes) {
    if (n.kept || !n.ttlAt) continue;
    const ends = parseTime(n.ttlAt);
    if (!Number.isFinite(ends) || ends < at.now.getTime()) continue;
    if (ends - at.now.getTime() <= at.days.expiring * DAY_MS) {
      items.push({
        keys: [`note:${n.id}:expiring`],
        line: `- ${quote(n)}: expires on ${new Date(ends).toISOString().slice(0, 10)}; keep it if it still matters`,
      });
    }
  }
  if (at.loaded && at.loaded.tokens > at.loaded.budget) {
    items.push({
      keys: [LOADED],
      line: `- Your pinned notes${at.coreMemory ? " and core memory" : ""} load on every turn: about ${at.loaded.tokens.toLocaleString("en-US")} tokens, over your budget of ${at.loaded.budget.toLocaleString("en-US")}.`,
    });
  }
  const unloaded = at.unloaded?.ids ?? [];
  if (unloaded.length) {
    const shown = unloaded.slice(0, PAIRS_SHOWN);
    const rest = unloaded.length - shown.length;
    items.push({
      keys: unloaded.map((id) => `note:${id}:unloaded`),
      line: `- Only ${at.unloaded?.fit ?? 0} of your ${unloaded.length + (at.unloaded?.fit ?? 0)} pinned notes fit in what loads every turn, so these never load: ${list([...shown, ...(rest > 0 ? [`${rest} more`] : [])])}. Archive the ones that matter less, or fold several into one.`,
    });
  }
  return items;
}

/** The evidence's fingerprint: its keys, in order. Two lots of evidence with the same keys are the same evidence. */
export function fingerprint(sections: Section[]): string {
  return [...new Set(sections.flatMap((s) => s.items.flatMap((i) => i.keys)))].sort().join("\n");
}

/**
 * The keys of `now` a stored fingerprint doesn't have: what is new since. An
 * empty answer means everything found was there before, or less: nothing to
 * wake an agent for.
 */
export function newKeys(now: string, before: string | undefined): string[] {
  const seen = new Set((before ?? "").split("\n"));
  return now ? now.split("\n").filter((k) => !seen.has(k)) : [];
}

// --------------------------------------------------------------------------
// The message
// --------------------------------------------------------------------------

/** What each tool is for in an upkeep turn, in the order the message names them. */
const TOOL_USES: [string, string][] = [
  ["commitment", "commitment to post an update, finish, drop or archive one"],
  ["writeup", "writeup to review or update a doc, or write one that's missing"],
  ["directory", "directory with action page to rewrite your page note"],
  ["recall", "recall to keep a note or archive it"],
  ["core_memory", "core_memory to shorten what's always loaded"],
];

/**
 * The one message an upkeep turn sends: the evidence, section by section,
 * then an invitation to tidy with the tools the agent has. Retiring something
 * means archiving it, and the message says so. No word to answer with: an
 * agent with nothing to change simply stops.
 */
export function upkeepMessage(at: {
  sections: Section[];
  /** When the last upkeep finished, when there was one. */
  since?: string;
  /** The tools the agent has, of those upkeep names. */
  tools: string[];
  maxRounds: number;
  /** The rooms the agent leads, by name, whose records it looks after too. */
  rooms?: string[];
}): string {
  const shown = at.sections.filter((s) => s.items.length);
  const rooms = at.rooms ?? [];
  const led = rooms.length
    ? `, and the ${rooms.length === 1 ? `${rooms[0]} room` : `rooms ${list(rooms)}`} you lead`
    : "";
  const lines = [
    at.since
      ? `Time to look after what you own${led}. Counted from your records since your last upkeep on ${at.since.slice(0, 10)}:`
      : `Time to look after what you own: your commitments, docs, page and notes${led}. Counted from your records:`,
  ];
  for (const section of shown) {
    lines.push("", section.title);
    lines.push(...section.items.slice(0, SECTION_SHOWN).map((i) => i.line));
    const rest = section.items.length - SECTION_SHOWN;
    if (rest > 0) lines.push(`- …and ${rest} more like these.`);
  }
  if (!shown.length) lines.push("", "Nothing you own stands out right now.");
  const uses = TOOL_USES.filter(([tool]) => at.tools.includes(tool)).map(([, use]) => use);
  // A room's records go by their ids like the agent's own; only something new for a room, or its note, needs its name.
  const roomUse =
    rooms.length && uses.length
      ? "For a room's, pass room with its name to write something new or its page note. "
      : "";
  lines.push(
    "",
    `${uses.length ? `Tidy what needs it with the tools you have: ${uses.join("; ")}. ` : ""}${roomUse}Retiring something means archiving it: nothing is deleted, and a person can bring it back. You have up to ${plural(at.maxRounds, "round")} of tool calls for this. Leave what's in order as it is.`,
    "Nobody reads a reply here; what you change is what people see.",
  );
  return lines.join("\n");
}

// --------------------------------------------------------------------------
// What a turn changed
// --------------------------------------------------------------------------

/** What an upkeep turn changed, by kind: how many records of the agent's each one touched. */
export interface Changed {
  archived: number;
  reviewed: number;
  updated: number;
  closed: number;
}

/** What kind of change one entry of a record's history is: an archive, a review, a close, or an update. */
export function classify(change: StateChange): keyof Changed | undefined {
  if (change.lifecycle === "archived") return "archived";
  if (change.lifecycle || change.op === "delete") return undefined;
  const before = change.before ?? {};
  const after = change.after ?? {};
  if (
    change.type === COMMITMENT_TYPE &&
    CLOSED.includes(String(after.status)) &&
    !CLOSED.includes(String(before.status))
  )
    return "closed";
  if (change.type === DOC_TYPE && change.op === "update") {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    keys.delete("reviewedAt");
    if ([...keys].every((k) => isDeepStrictEqual(before[k], after[k]))) return "reviewed";
  }
  return "updated";
}

/** The types whose history an upkeep turn's changes are counted from. */
const OWNED_TYPES = [COMMITMENT_TYPE, DOC_TYPE, PAGE_TYPE, PROFILE_TYPE];

// --------------------------------------------------------------------------
// The turn
// --------------------------------------------------------------------------

export interface UpkeepOptions {
  directory: Directory;
  settings: UpkeepSettings;
  /** Whether the agent has a tool, by name. */
  has: (agent: string, tool: string) => boolean;
  /** The memory store notes are read from; undefined, or one that can't list, leaves notes out. */
  memory?: () => Promise<MemoryBackend | undefined>;
  /** The embedder near-duplicate notes are matched by meaning with, when there is one. */
  embedder?: () => EmbeddingProvider | undefined;
  /** The agent's `upkeep:<agent>` session, found or made. */
  session: (agent: string) => { id: string };
  /**
   * Run the agent's turn in that session with `message`, taking at most
   * `maxRounds` rounds of tool calls: "ran", or why the waker turned it away.
   */
  run: (agent: string, session: { id: string }, message: string, maxRounds: number) => Promise<WakeOutcome>;
}

/** What upkeep found for one agent. */
export interface Found {
  sections: Section[];
  fingerprint: string;
  /** The tools it has, of those the message names. */
  tools: string[];
  /** The vectors its notes were compared by meaning with, when the embedder answered. */
  vectors?: Map<string, Float32Array>;
  /** Set when the embedder was asked and didn't answer: pairs only meaning would find may be missing. */
  meaningMissed?: true;
  /** The rooms the agent leads, by name, each with a section of its own. */
  rooms: string[];
}

/** Notes read for one upkeep: enough for any agent that keeps its notes tidy. */
const NOTES_READ = 500;
/** Notes compared by meaning, newest first: one embedding call's worth. */
const NOTES_EMBEDDED = 100;
/** How long upkeep waits for the embedder before matching notes by words alone. */
const EMBED_TIMEOUT_MS = 30_000;
/** Misses looked at on an agent's first upkeep, which has no "since". */
const FIRST_MISSES_DAYS = 14;

/** Runs agents' upkeep turns: gathers the evidence, decides whether to wake them, runs the turn and keeps the record. */
export class Upkeep {
  constructor(private readonly opts: UpkeepOptions) {}

  private get directory(): Directory {
    return this.opts.directory;
  }

  /**
   * Everything upkeep finds for `agent`, as of now: commitments, docs and
   * misses since `since`, its page, and its notes. Each kind only when the
   * agent has the tool to act on it. `reuse` is what this turn found before
   * the agent tidied: its notes' vectors are used again rather than asked
   * for, so a second look can't disagree with the first because the embedder
   * answered one and not the other.
   */
  async gather(
    agent: string,
    at: { since?: string; readsAtLast: Record<string, number>; reuse?: Found },
  ): Promise<Found> {
    const directory = this.directory;
    const now = directory.now();
    const { days } = this.opts.settings;
    const has = (tool: string) => this.opts.has(agent, tool);
    const tools = TOOL_USES.map(([tool]) => tool).filter(has);
    const owner = { owner: agent };
    const [commitments, docs, page, upkeep] = await Promise.all([
      directory.all(COMMITMENT_TYPE, owner),
      directory.all(DOC_TYPE, owner),
      directory.page(PERSON, agent),
      directory.upkeep(agent),
    ]);
    const sections: Section[] = [];

    if (has("commitment")) {
      sections.push({
        title: "Your commitments",
        items: commitmentItems(commitments, now, days, await this.waitingSince(commitments)),
      });
    }
    if (has("writeup")) {
      const since = at.since ? new Date(parseTime(at.since)) : new Date(now.getTime() - FIRST_MISSES_DAYS * DAY_MS);
      const misses = (await directory.all(MISS_TYPE, owner)).filter((m) => {
        const asked = parseTime(text(m.data.at) ?? m.createdAt);
        return Number.isFinite(asked) && asked >= since.getTime();
      });
      sections.push({
        title: "Your docs",
        items: docItems({
          docs,
          misses,
          reads: readsOf(upkeep?.data.reads),
          readsAtLast: at.readsAtLast,
          now,
          days,
          first: !at.since,
        }),
      });
    }
    if (has("directory")) {
      sections.push({ title: "Your page", items: pageItems(page, [...commitments, ...docs], now) });
    }
    let notes: Awaited<ReturnType<Upkeep["notes"]>> | undefined;
    if (has("recall")) {
      notes = await this.notes(agent, has("core_memory"), at.reuse);
      sections.push({ title: "Your notes", items: notes.items });
    }
    // The rooms it leads, each by the same rules as its own records.
    const led = await directory.ledBy(agent);
    for (const room of led) {
      sections.push({
        title: `The ${room.name} room, which you lead`,
        items: await this.roomItems(room, at.since, has),
      });
    }
    // Core memory is only worth naming when what loads every turn is over its budget.
    const loaded = sections.some((s) => s.items.some((i) => i.keys.includes(LOADED)));
    return {
      sections,
      fingerprint: fingerprint(sections),
      tools: tools.filter((t) => t !== "core_memory" || loaded),
      ...(notes?.vectors?.size ? { vectors: notes.vectors } : {}),
      ...(notes?.missed ? { meaningMissed: true as const } : {}),
      rooms: led.map((r) => r.name),
    };
  }

  /**
   * What needs a look among a room's own records, for its lead: commitments,
   * docs and misses in its area since `since`, and its page note, which its
   * profile holds. Each kind only when the lead has the tool to act on it.
   * Reads aren't counted for a room's docs: only its members can read them.
   */
  private async roomItems(room: RoomInfo, since: string | undefined, has: (tool: string) => boolean): Promise<Item[]> {
    const directory = this.directory;
    const now = directory.now();
    const { days } = this.opts.settings;
    const owner = { owner: roomOwner(room.ref) };
    const [commitments, docs, profile] = await Promise.all([
      directory.all(COMMITMENT_TYPE, owner),
      directory.all(DOC_TYPE, owner),
      directory.roomProfile(room),
    ]);
    const items: Item[] = [];
    if (has("commitment")) items.push(...commitmentItems(commitments, now, days, await this.waitingSince(commitments)));
    if (has("writeup")) {
      const from = since ? parseTime(since) : now.getTime() - FIRST_MISSES_DAYS * DAY_MS;
      const misses = (await directory.all(MISS_TYPE, owner)).filter((m) => {
        const asked = parseTime(text(m.data.at) ?? m.createdAt);
        return Number.isFinite(asked) && asked >= from;
      });
      items.push(
        ...docItems({ docs, misses, reads: {}, readsAtLast: {}, now, days, first: !since, area: "the room's" }),
      );
    }
    if (has("directory")) items.push(...pageItems(profile, [...commitments, ...docs], now, room));
    return items;
  }

  /**
   * When each waiting commitment started waiting, from its history: the
   * oldest of the changes in a row, newest back, that left it waiting. A
   * store that keeps no history leaves it to the last update.
   */
  private async waitingSince(records: StateRecord[]): Promise<Map<string, string>> {
    const since = new Map<string, string>();
    const service = this.directory.service();
    for (const r of records) {
      if (r.data.status !== "waiting" || r.archivedAt) continue;
      try {
        const history = await service.history(PERSON, { type: r.type, id: r.id }, { limit: 50 });
        let from: string | undefined;
        for (const change of history) {
          if (change.after?.status !== "waiting") break;
          from = change.at;
        }
        if (from) since.set(r.id, from);
      } catch (err) {
        if (!(err instanceof StateError)) throw err;
      }
    }
    return since;
  }

  /**
   * The agent's notes, read through the memory store, as evidence, with the
   * vectors they were compared by and whether the embedder failed to answer.
   * What `reuse` found earlier in the turn is used instead of asking the
   * embedder again. Nothing when there's no store that lists, or it can't be
   * read now: the rest of the evidence still stands.
   */
  private async notes(
    agent: string,
    coreMemory: boolean,
    reuse?: Found,
  ): Promise<{ items: Item[]; vectors?: Map<string, Float32Array>; missed: boolean }> {
    const backend = await this.opts.memory?.().catch(() => undefined);
    if (!backend?.list) return { items: [], missed: false };
    const { days, memoryBudget } = this.opts.settings;
    const now = this.directory.now();
    const fragments = await backend
      .list({ scope: `agent:${agent}`, kind: "note", allProjects: true, limit: NOTES_READ })
      .catch((err: unknown) => {
        console.warn(`[directory] upkeep couldn't read ${agent}'s notes: ${(err as Error).message}`);
        return [] as MemoryFragment[];
      });
    // What loads every turn: the pinned notes the store surfaces for the agent, and its core memory.
    const scope = memoryScope(null, agent);
    const surfaced = (await backend.query({ includePrelude: true, scope, limit: 100 }).catch(() => [])).filter(
      (f) => f.metadata?.pinned === true,
    );
    // A store pins by rules of its own (a tag, or high importance) and only says so here, so a listed note
    // that surfaced pinned is pinned, whatever its tags say.
    const pinnedIds = new Set(surfaced.map((f) => f.id));
    const notes = fragments
      .map((f) => noteOf(f, agent))
      .filter((n): n is NoteView => !!n)
      .map((n) => (pinnedIds.has(n.id) ? { ...n, pinned: true } : n));
    const { vectors, missed } = reuse
      ? { vectors: reuse.vectors, missed: !!reuse.meaningMissed }
      : await this.vectors(agent, notes);
    // Measured as the prompt takes them: only the pinned notes that fit load; the rest never do.
    const load = pinnedLoad(surfaced);
    const fit = new Set(load.included.map((p) => p.noteId));
    const unloaded = surfaced
      .map((f) => f.id ?? "")
      .filter((id) => id && !fit.has(id.startsWith("note:") ? id.slice("note:".length) : id));
    const core = backend.prelude ? await backend.prelude({ scope }).catch(() => "") : "";
    return {
      items: noteItems({
        notes,
        pairs: duplicatePairs(notes, vectors),
        now,
        days,
        loaded: { tokens: Math.ceil((load.charsUsed + core.length) / 4), budget: memoryBudget },
        coreMemory: coreMemory && core.length > 0,
        unloaded: { ids: unloaded, fit: load.included.length },
      }),
      ...(vectors ? { vectors } : {}),
      missed,
    };
  }

  /**
   * The notes' vectors, newest first up to one call's worth, to match them by
   * meaning. None with no embedder, or one that fails or doesn't answer in
   * time, which is `missed`: words still find the near-copies, and meaning
   * only adds the rewordings.
   */
  private async vectors(
    agent: string,
    notes: NoteView[],
  ): Promise<{ vectors?: Map<string, Float32Array>; missed: boolean }> {
    const embedder = this.opts.embedder?.();
    if (!embedder || notes.length < 2) return { missed: false };
    const compared = notes.slice(0, NOTES_EMBEDDED);
    const controller = new AbortController();
    try {
      const { vectors } = await within(
        () =>
          embedder.embed(
            compared.map((n) => n.text),
            { signal: controller.signal },
          ),
        EMBED_TIMEOUT_MS,
        controller,
      );
      return {
        vectors: new Map(compared.flatMap((n, i) => (vectors[i] ? [[n.id, vectors[i]] as const] : []))),
        missed: false,
      };
    } catch (err) {
      console.warn(`[directory] upkeep couldn't compare ${agent}'s notes by meaning: ${(err as Error).message}`);
      return { missed: true };
    }
  }

  /**
   * What the agent changed in its upkeep turn, which began at `started`: the
   * entries in its records' history written from the turn's session, by kind,
   * and the notes it archived since. Undefined when the store keeps no
   * history, so nothing can be counted.
   */
  async changes(agent: string, started: string): Promise<Changed | undefined> {
    const directory = this.directory;
    const service = directory.service();
    const from = parseTime(started);
    const touched: Record<keyof Changed, Set<string>> = {
      archived: new Set(),
      reviewed: new Set(),
      updated: new Set(),
      closed: new Set(),
    };
    // Its own records, and those of the rooms it leads, which its turn looks after too.
    const owners = [agent, ...(await directory.ledBy(agent)).map((r) => roomOwner(r.ref))];
    try {
      for (const type of OWNED_TYPES) {
        const records = (await Promise.all(owners.map((owner) => directory.all(type, { owner }, true)))).flat();
        for (const r of records) {
          if (parseTime(r.updatedAt) < from) continue;
          for (const change of await service.history(PERSON, { type, id: r.id }, { limit: 50 })) {
            if (parseTime(change.at) < from) break;
            if (change.source?.surface !== "upkeep" || change.source.onBehalfOf !== agent) continue;
            const kind = classify(change);
            if (kind) touched[kind].add(`${type}/${r.id}`);
          }
        }
      }
    } catch (err) {
      if (err instanceof StateError) return undefined;
      throw err;
    }
    const backend = await this.opts.memory?.().catch(() => undefined);
    if (backend?.list) {
      const notes = await backend
        .list({ scope: `agent:${agent}`, kind: "note", allProjects: true, includeArchived: true, limit: NOTES_READ })
        .catch(() => []);
      for (const n of notes) {
        const md = n.metadata ?? {};
        const at = text(md.archived_at);
        if (md.archived_by === agent && at && parseTime(at) >= from - 1_000) touched.archived.add(n.id ?? "");
      }
    }
    return {
      archived: touched.archived.size,
      reviewed: touched.reviewed.size,
      updated: touched.updated.size,
      closed: touched.closed.size,
    };
  }

  /**
   * One upkeep turn for `agent`. Gathers the evidence and, unless `force`,
   * wakes nobody when nothing in it is new since the last upkeep finished:
   * none at all, the same, or less (what cleared is forgotten, so it counts
   * as new if it comes back). Otherwise runs the turn, counts what it
   * changed from history, and keeps when, what changed and what the evidence
   * came to afterwards in the agent's upkeep record. "quiet" when it didn't
   * wake the agent. A failure anywhere is kept in the record, with when, for
   * the page, and thrown.
   *
   * A wake the waker turns away (at the agent's hourly ceiling, or paused)
   * ran nothing, so nothing is counted and the fingerprint stays for the next
   * turn. Asked for, why is kept in the record for the page, as a failure is;
   * on the schedule, the record is put back as it was, as for any skipped turn.
   */
  async turn(agent: string, opts: { force?: boolean } = {}): Promise<TurnOutcome> {
    const directory = this.directory;
    try {
      const record = await directory.upkeep(agent);
      const since = text(record?.data.at);
      const stored = typeof record?.data.fingerprint === "string" ? record.data.fingerprint : undefined;
      const before = await this.gather(agent, { since, readsAtLast: counts(record?.data.readsAtLast) });
      if (!opts.force && newKeys(before.fingerprint, stored).length === 0) {
        // Less than before: forget what cleared, so it counts as new if it comes back.
        const next = keepPairs(before, stored);
        if (stored !== undefined && stored !== next) await directory.saveUpkeep(agent, () => ({ fingerprint: next }));
        return "quiet";
      }

      const started = directory.now().toISOString();
      await directory.saveUpkeep(agent, () => ({ started, error: null, failedAt: null }));
      const message = upkeepMessage({
        sections: before.sections,
        ...(since ? { since } : {}),
        tools: before.tools,
        maxRounds: this.opts.settings.maxRounds,
        rooms: before.rooms,
      });
      const session = this.opts.session(agent);
      UPKEEP_SESSIONS.add(session.id);
      let outcome: WakeOutcome;
      try {
        outcome = await this.opts.run(agent, session, message, this.opts.settings.maxRounds);
      } finally {
        UPKEEP_SESSIONS.delete(session.id);
      }
      if (outcome !== "ran") {
        const was = record?.data ?? {};
        await directory.saveUpkeep(agent, () =>
          opts.force
            ? { error: REFUSED_WORDS[outcome], failedAt: directory.now().toISOString() }
            : {
                started: text(was.started) ?? null,
                error: text(was.error) ?? null,
                failedAt: text(was.failedAt) ?? null,
              },
        );
        return outcome;
      }

      const changed = await this.changes(agent, started);
      const fresh = await directory.upkeep(agent);
      const readsAtLast = counts(readsOf(fresh?.data.reads));
      const at = directory.now().toISOString();
      // What the evidence comes to now, after tidying: the next upkeep is skipped until something new turns up.
      const after = await this.gather(agent, { since: at, readsAtLast, reuse: before });
      await directory.saveUpkeep(agent, () => ({
        at,
        changed: changed ?? null,
        fingerprint: keepPairs(after, stored),
        readsAtLast,
        error: null,
        failedAt: null,
      }));
      return "woken";
    } catch (err) {
      const why = (err as Error).message || "it failed";
      const failedAt = directory.now().toISOString();
      await directory.saveUpkeep(agent, () => ({ error: why.slice(0, 500), failedAt })).catch(() => {});
      throw err;
    }
  }
}

/**
 * What to keep as `found`'s fingerprint. When the embedder didn't answer,
 * the pairs of notes `stored` had stay in it: they may be missing only
 * because meaning couldn't be asked, and dropping them would wake the agent
 * for pairs it has seen once the embedder answers again.
 */
function keepPairs(found: Found, stored: string | undefined): string {
  if (!found.meaningMissed || !stored) return found.fingerprint;
  const keys = new Set(found.fingerprint ? found.fingerprint.split("\n") : []);
  for (const key of stored.split("\n")) if (key.endsWith(PAIR_KEY)) keys.add(key);
  return [...keys].sort().join("\n");
}

/** Each doc's read count, from read records or a stored snapshot of them. */
function counts(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [id, v] of Object.entries(value as Record<string, unknown>)) {
    const n = typeof v === "number" ? v : (v as { n?: unknown } | null)?.n;
    if (typeof n === "number" && Number.isFinite(n)) out[id] = n;
  }
  return out;
}

/** An upkeep record's `changed`, read: undefined when it holds none, or none that can be read. */
export function changedOf(value: unknown): Changed | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const n = (k: string) => (typeof v[k] === "number" ? (v[k] as number) : 0);
  return { archived: n("archived"), reviewed: n("reviewed"), updated: n("updated"), closed: n("closed") };
}
