/**
 * Commitment checks: a commitment's `nextCheck`, read as a time or a change
 * to watch for, so the directory can wake its owner then. See
 * `docs/directory.md` (Checks) and the design in `docs/ownership-design.md`.
 *
 * `nextCheck` stays the text people and agents read and write. What the
 * directory can act on is kept beside it, in fields it maintains:
 *
 *   - `checkAt`: when the owner is next woken, in UTC (ISO);
 *   - `checkOn`: the record change that wakes it sooner, `{ type, id?, where? }`;
 *   - `checkedAt`: when it was last woken for one;
 *   - `checkEvents`: what changed since, for the next check to say why it came.
 *
 * They are read from the text whenever it's written: by the `commitment`
 * tool, which says what it made of it, and after a person's edit on the State
 * page or an agent or room page, which the directory notices from
 * `state.changed`. Text that is neither a time nor a change stays a note,
 * and nothing wakes the owner for it.
 */

import { isDeepStrictEqual } from "node:util";
import { formatDistance, formatLocal, parseWhen, WhenParseError } from "../schedules/when.js";
import type { StateCaller, StateService } from "../state/service.js";
import { type StateChange, StateConflictError, type StateRecord } from "../state/types.js";
import { describeEvent } from "../subscriptions/describe.js";
import {
  ACTIVE,
  CHECK_UPDATE,
  COMMITMENT_TYPE,
  checkedOnly,
  type Directory,
  formatProgress,
  NO_CHANGE,
  type Status,
  type Update,
  withUpdate,
} from "./directory-records.js";
import { roomOfOwner } from "./directory-rooms.js";

const DAY_MS = 86_400_000;

/** How long a check on a change waits at most: if nothing changes in a week, the owner is woken anyway. */
export const BACKSTOP_MS = 7 * DAY_MS;

/** The record change a check watches for. */
export interface CheckOn {
  type: string;
  /** One record; without it, any record of the type. */
  id?: string;
  /** Fields the changed record must have, compared as text. */
  where?: Record<string, string>;
}

/** What a commitment's `nextCheck` says, read. */
export type Check =
  | { kind: "time"; at: Date; defaultedTime: boolean }
  | { kind: "event"; on: CheckOn; backstop: Date }
  /** Neither a time nor a change. `why` says what was wrong with something that looked like a change. */
  | { kind: "note"; why?: string };

/** The fields the directory keeps beside `nextCheck`, as a patch: `null` takes one away. */
export interface CheckFields {
  checkAt: string | null;
  checkOn: CheckOn | null;
  checkEvents: null;
}

/** The forms a check wakes the owner for, as the note reply lists them. */
export const CHECK_FORMS =
  'a time ("Friday 9am", "in 2 days", "2026-10-28") or a change ("when plan/lisbon changes", "when plan changes")';

/** A record type or id as a check names it: what a world-state id allows. */
const NAME = "[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}";

/**
 * "when plan/lisbon changes", "when plan changes", "when a booking changes
 * where status=confirmed". The id is everything after the slash, which an id
 * can't contain.
 */
const EVENT = new RegExp(
  String.raw`^when\s+(?:(?:a|an|any)\s+)?(${NAME})(?:/(${NAME}))?\s+(?:record\s+)?changes?(?:\s+where\s+(.+?))?\s*[.!]?$`,
  "i",
);

/** `status=done`, `status is done`, joined by commas or "and". */
function parseWhere(text: string): Record<string, string> | undefined {
  const where: Record<string, string> = {};
  for (const part of text.split(/\s*,\s*|\s+and\s+/i)) {
    const m = /^([A-Za-z_][A-Za-z0-9_.]*)\s*(?:=|\s+is\s+)\s*(.+)$/i.exec(part.trim());
    if (!m) return undefined;
    where[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
  return Object.keys(where).length ? where : undefined;
}

/** The change a `nextCheck` names, or undefined when it doesn't read as one. */
export function parseEvent(text: string): CheckOn | undefined {
  const m = EVENT.exec(text.trim());
  if (!m) return undefined;
  const on: CheckOn = { type: m[1] };
  if (m[2]) on.id = m[2];
  if (m[3]) {
    const where = parseWhere(m[3]);
    if (!where) return undefined;
    on.where = where;
  }
  return on;
}

/**
 * Read a `nextCheck`. A time is read in `timeZone` with the parser the
 * `schedule` tool uses; a change is checked against what the agent to be
 * woken can read (`canRead`), since it can't watch a record it can't read.
 */
export function readCheck(
  text: string,
  at: { now: Date; timeZone: string; canRead: (type: string) => boolean },
): Check {
  const event = parseEvent(text);
  if (event) {
    if (!at.canRead(event.type)) {
      return { kind: "note", why: `there's no ${event.type} record type it can read` };
    }
    return { kind: "event", on: event, backstop: new Date(at.now.getTime() + BACKSTOP_MS) };
  }
  try {
    const { at: when, defaultedTime } = parseWhen(text, at.now, at.timeZone);
    return { kind: "time", at: when, defaultedTime };
  } catch (err) {
    // A time that doesn't exist, like 02:30 on the night clocks go forward, is said as what's wrong with it.
    if (err instanceof WhenParseError) return { kind: "note" };
    return { kind: "note", why: (err as Error).message };
  }
}

/** The fields to keep beside a `nextCheck` read as `check`; none for a note, or for no check at all. */
export function checkFields(check: Check | undefined): CheckFields {
  if (check?.kind === "time") return { checkAt: check.at.toISOString(), checkOn: null, checkEvents: null };
  if (check?.kind === "event") {
    return { checkAt: check.backstop.toISOString(), checkOn: check.on, checkEvents: null };
  }
  return { checkAt: null, checkOn: null, checkEvents: null };
}

/** The same fields for a record being created: only those with a value. */
export function newCheckFields(check: Check | undefined): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(checkFields(check))) if (value !== null) fields[key] = value;
  return fields;
}

/** "plan/lisbon", "any plan", "a plan with status=done": the change a check watches for, in words. */
export function describeOn(on: CheckOn): string {
  const where = on.where
    ? ` with ${Object.entries(on.where)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")}`
    : "";
  if (on.id) return `${on.type}/${on.id}${where}`;
  return where ? `a ${on.type}${where}` : `any ${on.type}`;
}

/**
 * What the `commitment` tool says it made of a `nextCheck`, the way
 * `schedule` echoes a booking: the time it resolved to and how far off, the
 * change it watches for and its backstop, or that it's a note nothing will
 * wake the owner for, with the forms that would.
 */
export function checkSaid(text: string, check: Check, now: Date, timeZone: string): string {
  if (check.kind === "time") {
    const when = formatLocal(check.at, timeZone);
    const ms = check.at.getTime() - now.getTime();
    const head =
      ms > 0 ? `Check: ${when}, in ${formatDistance(ms)}.` : `Check: ${when}, which has passed, so it's due now.`;
    return check.defaultedTime ? `${head} No time was given, so 09:00.` : head;
  }
  if (check.kind === "event") {
    return `Check: when ${describeOn(check.on)} changes, or ${formatLocal(check.backstop, timeZone)} if nothing does by then.`;
  }
  const why = check.why ? `: ${check.why}` : " or a change";
  return `"${text}" isn't a time${why}, so nothing will wake you for it; it stays a note. A check wakes you for ${CHECK_FORMS}.`;
}

/** The plugin's own writes for checks: every scope, as a person sees them, and marked so its listeners skip them. */
export const CHECK_SURFACE = "commitment-check";
export const CHECKER: StateCaller = {
  actor: { kind: "plugin", name: "directory" },
  source: { surface: CHECK_SURFACE },
};

/** Whether a change was written by the directory itself: its tools and checks read `nextCheck` as they write it. */
function byDirectory(change: StateChange): boolean {
  return change.actor.kind === "plugin" && change.actor.name === "directory";
}

/** The agent a check wakes: the commitment's owner, or for a room's own, its lead. Undefined when there's none. */
export async function wakeeOf(directory: Directory, owner: string | undefined): Promise<string | undefined> {
  const ref = roomOfOwner(owner);
  if (!ref) return owner;
  const room = directory.room(ref);
  if (!room || room.archived) return undefined;
  return (await directory.lead(room)).agent;
}

/** An agent as world state sees it reading for a check: the rooms it's in, as the directory reads for it. */
export async function readerFor(directory: Directory, agent: string): Promise<StateCaller> {
  return directory.widen({ actor: { kind: "agent", name: agent }, source: { surface: CHECK_SURFACE } });
}

/** Whether an agent can read records of a type at all. */
export function canReadType(service: StateService, caller: StateCaller, type: string): boolean {
  return service.listTypes(caller).some((v) => v.def.name === type);
}

/**
 * Read a `nextCheck` for a commitment owned by `owner`, as the agent it would
 * wake. A room with no lead to wake has no reader to check a change against,
 * so a change is taken as written.
 */
export async function readCheckFor(directory: Directory, owner: string | undefined, text: string): Promise<Check> {
  const agent = await wakeeOf(directory, owner);
  const reader = agent ? await readerFor(directory, agent) : undefined;
  const service = directory.service();
  return readCheck(text, {
    now: directory.now(),
    timeZone: directory.timeZone(),
    canRead: (type) => (reader ? canReadType(service, reader, type) : !!service.getType(type)),
  });
}

/**
 * Bring a commitment's check fields in line with a `nextCheck` someone other
 * than the directory wrote: a person on the State page, or on an agent or
 * room page. Written as the directory, against the version that change made.
 * A write that crossed it, such as the checker moving the check on, is read
 * past once: while the record still holds the text this change wrote, the
 * fields are worked out again against it. Text that has changed since is
 * left alone, since whoever changed it brings its own reading.
 */
export async function rederive(directory: Directory, change: StateChange): Promise<StateRecord | undefined> {
  if (change.type !== COMMITMENT_TYPE || change.op === "delete" || byDirectory(change)) return undefined;
  const before = change.before?.nextCheck;
  const written = change.after?.nextCheck;
  if (before === written || !change.after) return undefined;
  const service = directory.service();
  const ref = { type: change.type, id: change.id };
  let had: Record<string, unknown> = change.after;
  let version = change.version;
  for (let attempt = 0; ; attempt++) {
    const text = typeof written === "string" ? written.trim() : "";
    const status = String(had.status ?? "open") as Status;
    const check = text && ACTIVE.includes(status) ? await readCheckFor(directory, ownerIn(had), text) : undefined;
    const current = had;
    // Only what differs: a note where there was no check changes nothing, and writes nothing.
    const changes = Object.fromEntries(
      Object.entries(checkFields(check)).filter(([key, value]) => !isDeepStrictEqual(value ?? undefined, current[key])),
    );
    if (Object.keys(changes).length === 0) return undefined;
    try {
      return await service.patch(CHECKER, ref, changes, version);
    } catch (err) {
      if (!(err instanceof StateConflictError)) throw err;
      if (attempt >= 1) return undefined;
    }
    const fresh = await service.get(CHECKER, ref);
    if (!fresh || fresh.archivedAt || !isDeepStrictEqual(fresh.data.nextCheck, written)) return undefined;
    had = fresh.data;
    version = fresh.version;
  }
}

function ownerIn(data: Record<string, unknown>): string | undefined {
  const value = data.owner;
  return typeof value === "string" && value ? value : undefined;
}

// ------------------------------------------------------------------ the runner

/** The `wake.kind` of a turn a check starts. The suggest guard keys on it. */
export const CHECK_KIND = "commitment";

/** How often due checks are looked for. */
export const CHECK_TICK_MS = 30_000;

/** At the agent's hourly wake ceiling, a check comes round again this much later, or when the hour has room. */
export const CEILING_DELAY_MS = 5 * 60_000;

/**
 * How long a claimed check is held. The claim moves the check this far on
 * rather than taking it away, so a turn that never gets to its end (the
 * process stopped in the middle, or the write after it failed) comes round
 * again then instead of never. Longer than a turn: within one runtime,
 * nothing starts beside a running check anyway.
 */
export const LEASE_MS = 60 * 60_000;

/** Days to the next check after one that changed nothing: the first, the second, the third, then every one after. */
export const BACKOFF_DAYS = [1, 2, 4, 7];

/** What a check that ended with no update to its commitment writes for it. */
export { NO_CHANGE };

/** Due checks tried per look. One at a time, oldest first; the rest wait for the next look. */
const DUE_READ = 20;

/** Lines kept of what a check on a change saw, newest first; the last says how many more there were. */
const EVENTS_KEPT = 5;

/** How long a burst of changes is gathered before it's written onto its commitments. */
const GATHER_MS = 1_000;

/** Updates a check's prompt shows, newest first. */
const UPDATES_SHOWN = 3;

/** The session a check's turn runs in: one per commitment, so each check sees the last. */
export const checkSession = (id: string) => `commitment:${id}`;

/** Why a turn runs, as `runtime.wakeAgent` takes it and `agent.pre_tool_use` hands it on. */
type CheckWake = { kind: string; ref?: string };

export interface CheckerOptions {
  directory: Directory;
  /** The runtime's waker: the one way to wake an agent, under its brakes. */
  wake: (
    agent: string,
    opts: { prompt: string; sessionKey: string; wake: CheckWake },
  ) => Promise<"ran" | "paused" | "at-ceiling" | "gone">;
  /**
   * Why the waker would turn a wake away now, or undefined when it would run.
   * Counts nothing. `until`, at the ceiling, is when the hour has room.
   */
  refusal: (
    agent: string,
    where: { sessionKey: string },
  ) => { outcome: "paused" | "at-ceiling" | "gone"; why: string; until?: number } | undefined;
  /** Whether turns nobody asked for are paused for everyone. A look then reads nothing, since nothing could run. */
  paused?: () => boolean;
  /** Whether an agent can record what it did: it has the `commitment` tool. */
  canUpdate: (agent: string) => boolean;
  /**
   * What the checkers of one runtime share, so the checker a reload starts
   * waits for a check the last one began. Checkers of different runtimes in
   * one process don't wait for each other. Without one, every checker given
   * none shares one.
   */
  lock?: object;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

/** A commitment that watches for a change, as the index keeps it. */
interface Watch {
  id: string;
  on: CheckOn;
  owner?: string;
  /** The commitment's own scope. Whatever it's told of a change, everyone who can read it is told too. */
  scope: string;
}

/**
 * The look in hand, by lock (`CheckerOptions.lock`). A reload stops one
 * checker and starts the next while a turn the old one began may still be
 * running: the new one starts nothing until that's done, so checks go one at
 * a time across a reload too. The claim on the record is what keeps the same
 * check from running twice.
 */
const running = new WeakMap<object, Promise<void>>();

/** The lock of every checker given none. */
const SHARED = {};

/** A check's fields read off a record, leaving out what a hand edit made unusable. */
export function checkOnOf(value: unknown): CheckOn | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { type, id, where } = value as Record<string, unknown>;
  if (typeof type !== "string" || !type) return undefined;
  const on: CheckOn = { type };
  if (typeof id === "string" && id) on.id = id;
  if (where && typeof where === "object" && !Array.isArray(where)) {
    on.where = Object.fromEntries(Object.entries(where).map(([k, v]) => [k, String(v)]));
  }
  return on;
}

const active = (data: Record<string, unknown>) => ACTIVE.includes(String(data.status ?? "open") as Status);
const stamp = (value: unknown) => (typeof value === "string" && value ? value : undefined);
const textOf = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

/** Whether a check is held by its claim, its time the lease from when it was checked: its turn is running. */
export function leased(data: Record<string, unknown>): boolean {
  const checked = Date.parse(stamp(data.checkedAt) ?? "");
  return Number.isFinite(checked) && stamp(data.checkAt) === new Date(checked + LEASE_MS).toISOString();
}

/**
 * A commitment's check as its line says it to an agent: what the directory
 * read, so "in 2 days" doesn't still say so a week on. The change it watches
 * for, the time it's next woken ("now" while its check runs), or the text
 * itself for a note, for one written before checks were read, and for work
 * that's finished.
 */
export function checkLine(data: Record<string, unknown>, timeZone: string): string | undefined {
  if (!active(data)) return textOf(data.nextCheck);
  const on = checkOnOf(data.checkOn);
  if (on) return `when ${describeOn(on)} changes`;
  if (leased(data)) return "now";
  const at = Date.parse(stamp(data.checkAt) ?? "");
  return Number.isFinite(at) ? formatLocal(new Date(at), timeZone) : textOf(data.nextCheck);
}

/**
 * Whether a commitment's `nextCheck` was written before the directory read
 * checks: active, with text, and none of the fields the directory keeps.
 */
function unread(record: StateRecord): boolean {
  const d = record.data;
  return (
    !record.archivedAt &&
    active(d) &&
    !!textOf(d.nextCheck) &&
    ["checkAt", "checkOn", "checkedAt"].every((key) => d[key] === undefined)
  );
}

/** A `nextCheck` that reads the same whenever it's read: a change, or a date ("2026-10-28", "2026-10-28 14:00"). */
function fixed(text: string): boolean {
  return !!parseEvent(text) || /^\d{4}-\d{2}-\d{2}\b/.test(text.trim());
}

function updatesOf(data: Record<string, unknown>): Update[] {
  return Array.isArray(data.updates) ? (data.updates as Update[]).filter((u) => u && typeof u.text === "string") : [];
}

/** The newest update, as a key: what tells a turn that wrote one from a turn that didn't. */
function newest(data: Record<string, unknown>): string {
  const u = updatesOf(data)[0];
  return u ? `${u.at}\n${u.text}` : "";
}

/** When the next check falls after one that changed nothing, or that left no check of its own. */
export function backoff(updates: Update[], now: Date): Date {
  let quiet = 0;
  while (quiet < updates.length && checkedOnly(updates[quiet])) quiet++;
  const days = BACKOFF_DAYS[Math.min(Math.max(quiet - 1, 0), BACKOFF_DAYS.length - 1)];
  return new Date(now.getTime() + days * DAY_MS);
}

/** New lines in front of the old, at most {@link EVENTS_KEPT}, the last counting the rest. */
export function withEvents(fresh: string[], old: unknown): string[] {
  const more = /^…and (\d+) more$/;
  let dropped = 0;
  const kept: string[] = [];
  for (const line of [...fresh, ...(Array.isArray(old) ? old : [])]) {
    if (typeof line !== "string") continue;
    const m = more.exec(line);
    if (m) dropped += Number(m[1]);
    else kept.push(line);
  }
  if (kept.length + (dropped ? 1 : 0) <= EVENTS_KEPT) return dropped ? [...kept, `…and ${dropped} more`] : kept;
  const shown = kept.slice(0, EVENTS_KEPT - 1);
  return [...shown, `…and ${dropped + kept.length - shown.length} more`];
}

/** Whether a change was the agent's own doing: by it, or written for it. A check doesn't wake it for its own. */
function madeBy(change: StateChange, agent: string): boolean {
  if (change.actor.kind === "agent" && change.actor.name === agent) return true;
  return change.source?.onBehalfOf === agent;
}

function field(data: Record<string, unknown> | undefined, path: string): unknown {
  let at: unknown = data;
  for (const key of path.split(".")) {
    if (!at || typeof at !== "object") return undefined;
    at = (at as Record<string, unknown>)[key];
  }
  return at;
}

/** Whether a change is the kind a check watches for, before asking whether its agent can read it. */
export function matches(on: CheckOn, change: StateChange): boolean {
  if (change.type !== on.type || (on.id && on.id !== change.id)) return false;
  if (!on.where) return true;
  const data = change.after ?? change.before;
  return Object.entries(on.where).every(([key, wanted]) => {
    const value = field(data, key);
    return value !== undefined && value !== null && String(value) === wanted;
  });
}

/**
 * What a check's turn is told, kept small: the commitment, how to tell it's
 * done, the next step, the newest updates, why it's due, what it may do, and
 * what to do.
 */
export function checkPrompt(record: StateRecord, at: { timeZone: string; whose: string }): string {
  const d = record.data;
  const lines: string[] = [];
  const status = String(d.status ?? "open");
  const said = [status === "waiting" && textOf(d.waitingOn) ? `waiting on ${textOf(d.waitingOn)}` : status];
  const progress = formatProgress(d.progress);
  if (progress) said.push(progress);
  lines.push(`Time to check on ${at.whose} commitment ${record.id} "${textOf(d.goal) ?? ""}" (${said.join(", ")}).`);
  if (textOf(d.doneWhen)) lines.push(`Done when: ${textOf(d.doneWhen)}`);
  if (textOf(d.nextStep)) lines.push(`Next step: ${textOf(d.nextStep)}`);
  const updates = updatesOf(d).slice(0, UPDATES_SHOWN);
  if (updates.length) {
    lines.push("Latest:");
    for (const u of updates) lines.push(`- ${String(u.at).slice(0, 10)}: ${u.text}`);
  }
  const events = stringsOf(d.checkEvents);
  const on = checkOnOf(d.checkOn);
  const dueAt = stamp(d.checkAt);
  if (events.length) {
    lines.push("Why now: what it watches changed.", ...events.map((e) => `- ${e}`));
  } else if (on) {
    lines.push(`Why now: nothing it watches (when ${describeOn(on)} changes) has changed for a while.`);
  } else if (dueAt) {
    const words = textOf(d.nextCheck);
    lines.push(
      `Why now: its check was due ${formatLocal(new Date(dueAt), at.timeZone)}${words ? ` ("${words}")` : ""}.`,
    );
  }
  const autonomy = String(d.autonomy ?? "suggest");
  // What the guard below lets through, in the same words: its own tools, and tools that say they only read.
  const rule =
    "update your commitments and docs and read records and files, but put anything that would change something else in nextStep and set the commitment waiting on a person.";
  lines.push(
    autonomy === "suggest"
      ? `It asks first: ${rule}`
      : `It's marked ${autonomy}, but for now every check asks first: ${rule}`,
  );
  lines.push(
    `Do the next step, then update the commitment with progress and a new check (commitment update, id ${record.id}).`,
  );
  return lines.join("\n");
}

/**
 * Wakes a commitment's owner when its check comes due: on the time it was
 * read as, or as soon as a change it watches for happens. One check at a
 * time, oldest first, each through `runtime.wakeAgent` in the commitment's
 * own session, so the pause, the agent's own switch and its hourly wake
 * ceiling apply as they do to every turn nobody asked for.
 */
export class Checker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private gather: ReturnType<typeof setTimeout> | undefined;
  private readonly watches = new Map<string, Watch>();
  /** What changes were seen, by commitment, not yet written onto it. */
  private readonly seen = new Map<string, string[]>();
  private stopped = true;
  private readonly lock: object;
  private readonly log: (line: string) => void;
  private readonly warn: (line: string) => void;

  constructor(private readonly opts: CheckerOptions) {
    this.lock = opts.lock ?? SHARED;
    this.log = opts.log ?? ((line) => console.log(`[directory] ${line}`));
    this.warn = opts.warn ?? ((line) => console.warn(`[directory] ${line}`));
  }

  private get directory(): Directory {
    return this.opts.directory;
  }

  /**
   * Start looking: the commitments that watch for a change are read (and
   * those written before checks were read, read once), then due checks
   * every thirty seconds.
   */
  start(): Promise<void> {
    this.stop();
    this.stopped = false;
    const indexed = this.index().catch((err: unknown) =>
      this.warn(`couldn't read which commitments watch for a change: ${(err as Error).message}`),
    );
    this.tick();
    this.timer = setInterval(() => this.tick(), CHECK_TICK_MS);
    this.timer.unref?.();
    return indexed;
  }

  /**
   * Stop looking. A check already running finishes, and changes seen but
   * not yet written are written now, so a reload loses none of them.
   */
  stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const wasRunning = !this.stopped;
    this.stopped = true;
    return wasRunning ? this.flush() : Promise.resolve();
  }

  /** The look running now under this checker's lock, a reloaded one's included: what a test waits for. */
  idle(): Promise<void> {
    return running.get(this.lock) ?? Promise.resolve();
  }

  /** The commitments watching for a change now, by id. */
  watching(): string[] {
    return [...this.watches.keys()].sort();
  }

  /** One look for due checks. Nothing starts while a look is running under the same lock, this checker's or not. */
  tick(): void {
    if (this.stopped || running.has(this.lock)) return;
    const look = this.run()
      .catch((err: unknown) => this.warn(`commitment checks failed: ${(err as Error).message}`))
      .finally(() => running.delete(this.lock));
    running.set(this.lock, look);
  }

  /**
   * One look: due checks, oldest first, until {@link DUE_READ} have been
   * tried. An agent found paused is passed over for the rest of the look,
   * its checks left due, so one switched-off agent can't hold up everyone
   * else's. Paused for everyone, nothing is read.
   */
  private async run(): Promise<void> {
    if (!this.directory.active() || this.opts.paused?.()) return;
    const now = this.directory.now();
    const paused = new Set<string>();
    let tried = 0;
    // Checks left due stay in the query's answer, so each page starts past them. The rest moved on when tried.
    let left = 0;
    for (;;) {
      const due = await this.directory.service().query(CHECKER, {
        type: COMMITMENT_TYPE,
        where: { status: { in: [...ACTIVE] }, checkAt: { lte: now.toISOString() } },
        orderBy: { field: "checkAt", direction: "asc" },
        limit: DUE_READ,
        offset: left,
      });
      for (const record of due) {
        // A checker a reload stopped finishes the check in hand and starts no other: the next load takes them.
        if (this.stopped) return;
        if (await this.check(record.id, paused)) tried++;
        else if (this.opts.paused?.()) return;
        else left++;
        if (tried >= DUE_READ) return;
      }
      if (due.length < DUE_READ) return;
    }
  }

  /**
   * One check. It's claimed before the turn (its time moved a lease on,
   * `checkedAt` set), so a slow turn is never started twice, however many
   * looks or loads come while it runs. Paused, it stays due and nothing is
   * written; at the agent's hourly ceiling it comes round five minutes on,
   * or when the hour has room. False when it was left due for a paused agent,
   * whose other checks the look then passes over.
   */
  private async check(id: string, paused: Set<string>): Promise<boolean> {
    const service = this.directory.service();
    const ref = { type: COMMITMENT_TYPE, id };
    const now = this.directory.now();
    const record = await service.get(CHECKER, ref);
    const due = stamp(record?.data.checkAt);
    // Looked at again: it may have been finished, archived, moved on or claimed since the query.
    if (!record || record.archivedAt || !active(record.data) || !due || due > now.toISOString()) return true;
    const owner = stamp(record.data.owner);
    const agent = await wakeeOf(this.directory, owner);
    if (!agent) {
      const room = roomOfOwner(owner);
      await this.giveUp(record, room ? `${this.directory.ownerName(owner)} has no lead to wake` : "it has no owner");
      return true;
    }
    if (paused.has(agent)) return false;
    if (!this.opts.canUpdate(agent)) {
      // It couldn't write down what it found, so a turn would be spent for nothing. Config may give it the tool.
      this.log(`${agent} has no commitment tool, so its check on ${id} waits a day`);
      await this.amend(id, () => ({ checkAt: new Date(now.getTime() + DAY_MS).toISOString() }));
      return true;
    }
    const sessionKey = checkSession(id);
    const refused = this.opts.refusal(agent, { sessionKey });
    if (refused?.outcome === "paused") {
      paused.add(agent);
      return false;
    }
    if (refused?.outcome === "gone") {
      await this.giveUp(record, refused.why);
      return true;
    }
    if (refused) {
      const later = this.later(now, refused.until);
      this.log(`${agent}'s check on ${id} waits until ${later.toISOString()}: ${refused.why}`);
      await this.amend(id, (data) =>
        data.checkAt === record.data.checkAt ? { checkAt: later.toISOString() } : undefined,
      );
      return true;
    }

    const lease = new Date(now.getTime() + LEASE_MS).toISOString();
    let claimed: StateRecord;
    try {
      claimed = await service.patch(
        CHECKER,
        ref,
        { checkAt: lease, checkedAt: now.toISOString(), checkEvents: null },
        record.version,
      );
    } catch (err) {
      // Changed since it was read: the next look sees it as it is now.
      if (err instanceof StateConflictError) return true;
      throw err;
    }
    const prompt = checkPrompt(record, {
      timeZone: this.directory.timeZone(),
      whose: owner && roomOfOwner(owner) ? `${this.directory.ownerName(owner)}'s` : "your",
    });
    let outcome: "ran" | "paused" | "at-ceiling" | "gone" | undefined;
    let failure: Error | undefined;
    try {
      outcome = await this.opts.wake(agent, { prompt, sessionKey, wake: { kind: CHECK_KIND, ref: id } });
    } catch (err) {
      failure = err as Error;
    }
    await this.after(record, claimed, { agent, sessionKey, lease }, outcome, failure);
    if (outcome !== "paused") return true;
    paused.add(agent);
    return false;
  }

  /** When a check turned away at the ceiling comes round: five minutes on, or when the hour has room if that's later. */
  private later(now: Date, until: number | undefined): Date {
    return new Date(Math.max(now.getTime() + CEILING_DELAY_MS, until ?? 0));
  }

  /**
   * What follows a check's wake: put it back when it was turned away, and
   * after a turn, its next check. A check still on its lease is one nobody
   * set again during the turn, the agent, a person or a change it watches;
   * any other a turn leaves stands, a note included, since the agent was told
   * nothing wakes it for one.
   */
  private async after(
    was: StateRecord,
    claimed: StateRecord,
    turn: { agent: string; sessionKey: string; lease: string },
    outcome: "ran" | "paused" | "at-ceiling" | "gone" | undefined,
    failure: Error | undefined,
  ): Promise<void> {
    const id = was.id;
    const held = (data: Record<string, unknown>) => stamp(data.checkAt) === turn.lease;
    // Turned away after all, between the look and the wake: as it would have been before the claim.
    if (outcome === "paused" || outcome === "at-ceiling") {
      const at =
        outcome === "paused"
          ? stamp(was.data.checkAt)
          : this.later(
              this.directory.now(),
              this.opts.refusal(turn.agent, { sessionKey: turn.sessionKey })?.until,
            ).toISOString();
      await this.amend(id, (data) => {
        if (!held(data)) return undefined;
        const events = withEvents(stringsOf(data.checkEvents), was.data.checkEvents);
        return {
          checkAt: at ?? null,
          checkedAt: stamp(was.data.checkedAt) ?? null,
          checkEvents: events.length ? events : null,
        };
      });
      return;
    }
    if (outcome === "gone") {
      const fresh = await this.directory.service().get(CHECKER, { type: COMMITMENT_TYPE, id });
      if (fresh) await this.giveUp(fresh, "there's no agent to wake");
      return;
    }
    const now = this.directory.now();
    await this.amend(id, (data) => {
      // Finished during the turn: no note, and no check left on it.
      if (!active(data)) return held(data) ? { checkAt: null } : undefined;
      const changes: Record<string, unknown> = {};
      let updates = updatesOf(data);
      if (failure) {
        updates = withUpdate(updates, {
          at: now.toISOString(),
          text: `The check stopped with an error: ${failure.message}`,
        });
        changes.updates = updates;
      } else if (newest(data) === newest(claimed.data)) {
        updates = withUpdate(updates, { at: now.toISOString(), text: NO_CHANGE, kind: CHECK_UPDATE });
        changes.updates = updates;
      }
      if (held(data)) {
        changes.checkAt = (
          checkOnOf(data.checkOn) ? new Date(now.getTime() + BACKSTOP_MS) : backoff(updates, now)
        ).toISOString();
      }
      return Object.keys(changes).length ? changes : undefined;
    });
    if (failure) this.warn(`the check on ${id} stopped with an error: ${failure.message}`);
  }

  /** A check with nobody to wake: taken off, with an update saying why, so the page shows it. */
  private async giveUp(record: StateRecord, why: string): Promise<void> {
    this.log(`the check on ${record.id} was dropped: ${why}`);
    await this.amend(record.id, (data) => ({
      checkAt: null,
      updates: withUpdate(data.updates, {
        at: this.directory.now().toISOString(),
        text: `Couldn't check on it: ${why}.`,
      }),
    }));
  }

  /**
   * Change a commitment as the checker: `change` gets its fields as they
   * stand and returns the ones to set, or undefined to leave it. Nothing is
   * written to one that's gone or archived. A write that crossed another is
   * tried once more against the fresh record.
   */
  private async amend(
    id: string,
    change: (data: Record<string, unknown>) => Record<string, unknown> | undefined,
  ): Promise<void> {
    const service = this.directory.service();
    const ref = { type: COMMITMENT_TYPE, id };
    for (let attempt = 0; ; attempt++) {
      const record = await service.get(CHECKER, ref);
      if (!record || record.archivedAt) return;
      const changes = change({ ...record.data });
      if (!changes) return;
      try {
        await service.patch(CHECKER, ref, changes, record.version);
        return;
      } catch (err) {
        if (!(err instanceof StateConflictError) || attempt >= 1) throw err;
      }
    }
  }

  // ---------------------------------------------------------------- changes

  /**
   * Read which commitments watch for a change. After that, `onChange` keeps
   * it current. A commitment written before the directory read checks, whose
   * `nextCheck` reads the same whenever it's read (a date, or a change), is
   * read now, once, so it wakes its owner like one written today. A relative
   * one ("in 2 days", "Friday") is left as written: what it meant when it was
   * written can't be told now.
   */
  private async index(): Promise<void> {
    const all = await this.directory.all(COMMITMENT_TYPE);
    for (const record of all) {
      const read = unread(record) ? await this.backfill(record) : record;
      if (read) this.keep(read.id, read.data, read.scope, !!read.archivedAt);
    }
  }

  /** Read an older commitment's `nextCheck` that reads the same whenever it's read. Undefined if it changed meanwhile. */
  private async backfill(record: StateRecord): Promise<StateRecord | undefined> {
    const text = textOf(record.data.nextCheck);
    if (!text || !fixed(text)) return record;
    const fields = newCheckFields(await readCheckFor(this.directory, stamp(record.data.owner), text));
    if (Object.keys(fields).length === 0) return record;
    try {
      return await this.directory
        .service()
        .patch(CHECKER, { type: COMMITMENT_TYPE, id: record.id }, fields, record.version);
    } catch (err) {
      // Written since it was read, by a load or a writer that reads checks itself; its change keeps the index.
      if (err instanceof StateConflictError) return undefined;
      throw err;
    }
  }

  private keep(id: string, data: Record<string, unknown> | undefined, scope: string, archived: boolean): void {
    const on = checkOnOf(data?.checkOn);
    if (!archived && data && on && active(data)) this.watches.set(id, { id, on, owner: stamp(data.owner), scope });
    else this.watches.delete(id);
  }

  /**
   * A change anywhere in world state: it keeps the index of watching
   * commitments current, and wakes the owner of each one it matches, if that
   * agent can read what changed. The directory's own check writes are never
   * a change worth waking for, and an agent isn't woken for its own.
   */
  onChange(change: StateChange): void {
    if (this.stopped) return;
    if (change.type === COMMITMENT_TYPE) {
      if (change.op === "delete") this.watches.delete(change.id);
      else this.keep(change.id, change.after, change.scope, change.lifecycle === "archived");
    }
    if (change.source?.surface === CHECK_SURFACE) return;
    // A check someone set for a time already gone is due now, not at the next look.
    const at = change.type === COMMITMENT_TYPE ? stamp(change.after?.checkAt) : undefined;
    if (at && at <= this.directory.now().toISOString()) setImmediate(() => this.tick());
    for (const watch of this.watches.values()) {
      if (!matches(watch.on, change)) continue;
      this.saw(watch, change).catch((err: unknown) =>
        this.warn(`couldn't note a change for the check on ${watch.id}: ${(err as Error).message}`),
      );
    }
  }

  private async saw(watch: Watch, change: StateChange): Promise<void> {
    const agent = await wakeeOf(this.directory, watch.owner);
    if (!agent || madeBy(change, agent)) return;
    const reader = await readerFor(this.directory, agent);
    const service = this.directory.service();
    // Read as the agent: it can't watch a record it can't read.
    const readable =
      change.op === "delete"
        ? canReadType(service, reader, change.type) && (service.visibleScopes(reader)?.includes(change.scope) ?? true)
        : !!(await service.get(reader, { type: change.type, id: change.id }));
    if (!readable) return;
    this.seen.set(watch.id, [this.said(watch, change), ...(this.seen.get(watch.id) ?? [])]);
    if (!this.gather) {
      this.gather = setTimeout(() => void this.flush(), GATHER_MS);
      this.gather.unref?.();
    }
  }

  /**
   * The line a change leaves on the commitment watching it. Everyone who can
   * read the commitment reads the line, and that can be more than can read
   * what changed: the agent it wakes can, but a shared commitment is read by
   * every agent. So a change is told in full, values and all, only when its
   * record is as open as the commitment: global or in the commitment's own
   * scope, and of a type anyone may read. Otherwise the line says no more
   * than the commitment already does, and the agent reads the record itself.
   */
  private said(watch: Watch, change: StateChange): string {
    const read = this.directory.service().getType(change.type)?.access?.read;
    const open = !read || (read.includes("*") && read.includes("user"));
    if (open && (change.scope === "global" || change.scope === watch.scope)) {
      return describeEvent("state.changed", change);
    }
    return watch.on.id
      ? `${change.type}/${change.id} changed; read it to see how`
      : `a ${change.type} it watches changed; look it up to see which`;
  }

  /**
   * Write what was seen onto each commitment: due now, with the lines that
   * say why. However many changes a burst brings, the next look finds one
   * due check, and one wake tells the agent about all of them.
   */
  async flush(): Promise<void> {
    if (this.gather) clearTimeout(this.gather);
    this.gather = undefined;
    const batch = [...this.seen.entries()];
    this.seen.clear();
    const now = this.directory.now().toISOString();
    for (const [id, lines] of batch) {
      try {
        await this.amend(id, (data) => {
          if (!active(data)) return undefined;
          const at = stamp(data.checkAt);
          return { checkAt: at && at < now ? at : now, checkEvents: withEvents(lines, data.checkEvents) };
        });
      } catch (err) {
        this.warn(`couldn't note a change for the check on ${id}: ${(err as Error).message}`);
      }
    }
    if (batch.length) this.tick();
  }
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

// ------------------------------------------------------------------ the suggest guard

/** The directory's own tools, which a check's turn may always use: it's how the agent records what it found. */
const OWN_TOOLS = new Set(["commitment", "writeup", "directory"]);

/** What a check's turn is told when a call would change something outside the directory. */
export const ASKS_FIRST = "This commitment asks first: put it in nextStep and set the commitment waiting on a person.";

/** What a check's turn is told when a tool says nothing of what it does, so it can't be let through as a read. */
export const notOpen = (tool: string) =>
  `"${tool}" isn't open to a commitment check yet: note in nextStep what you'd use it for.`;

/**
 * Until autonomy is enforced, every check's turn acts as `suggest`: a call
 * that writes or can't be undone is refused with one sentence, and so is one
 * whose tool says nothing of what it does, in its own sentence, since it may
 * only be a read. The agent's own directory tools and declared reads go
 * through. Undefined for a call that may go ahead, and for every turn a check
 * didn't start, a person's chat included.
 */
export function asksFirst(call: {
  tool: string;
  effect: "read" | "write" | "irreversible";
  effectDeclared: boolean;
  wake?: { kind: string };
}): string | undefined {
  if (call.wake?.kind !== CHECK_KIND || OWN_TOOLS.has(call.tool)) return undefined;
  if (!call.effectDeclared) return notOpen(call.tool);
  return call.effect === "read" ? undefined : ASKS_FIRST;
}
