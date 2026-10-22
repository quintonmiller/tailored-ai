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
 *   - `checkedAt`: when it was last woken for one.
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
import { ACTIVE, COMMITMENT_TYPE, type Directory, type Status } from "./directory-records.js";
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
 * room page. Written as the directory, against the version that change made:
 * a later write either came from the tools, which read the text themselves,
 * or brings its own change to look at, so a conflict is left alone.
 */
export async function rederive(directory: Directory, change: StateChange): Promise<StateRecord | undefined> {
  if (change.type !== COMMITMENT_TYPE || change.op === "delete" || byDirectory(change)) return undefined;
  const before = change.before?.nextCheck;
  const after = change.after?.nextCheck;
  if (before === after || !change.after) return undefined;
  const text = typeof after === "string" ? after.trim() : "";
  const status = String(change.after.status ?? "open") as Status;
  const check = text && ACTIVE.includes(status) ? await readCheckFor(directory, owner(change), text) : undefined;
  const had = change.after;
  // Only what differs: a note where there was no check changes nothing, and writes nothing.
  const changes = Object.fromEntries(
    Object.entries(checkFields(check)).filter(([key, value]) => !isDeepStrictEqual(value ?? undefined, had[key])),
  );
  if (Object.keys(changes).length === 0) return undefined;
  try {
    return await directory.service().patch(CHECKER, { type: change.type, id: change.id }, changes, change.version);
  } catch (err) {
    if (err instanceof StateConflictError) return undefined;
    throw err;
  }
}

function owner(change: StateChange): string | undefined {
  const value = change.after?.owner;
  return typeof value === "string" && value ? value : undefined;
}
