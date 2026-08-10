/**
 * When does an agent want to be woken?
 *
 * Two grammars live here:
 *
 *   parseWhen("10 minutes")            -> a single absolute moment
 *   parseEvery("weekdays at 9am")      -> a recurrence
 *
 * `cron/schedule-dsl.ts` already compiles recurrences and says in its own
 * header that one-shot timestamps are out of scope and "tracked separately".
 * This is that. Recurrences are delegated straight back to it rather than
 * reimplemented, so the phrases an operator learns in `config.yaml` are the
 * same ones an agent can use at runtime.
 *
 * Civil-time forms resolve in the supplied IANA timezone. Relative durations
 * are absolute elapsed time and therefore timezone-independent.
 */

import { Cron } from "croner";
import { compileSchedule, parseTime } from "../cron/schedule-dsl.js";
import { systemTimeZone } from "../time/provider.js";
import { addCivilDays, fromZonedParts, zonedParts } from "../time/zoned.js";

/** Hour applied when the agent gives a date with no time. Echoed back, never silent. */
export const DEFAULT_HOUR = 9;

export interface ParsedWhen {
  /** The absolute moment the input resolves to, in local time. */
  at: Date;
  /** Set when a date arrived with no clock time and DEFAULT_HOUR was applied. */
  defaultedTime: boolean;
}

/**
 * The forms `when` accepts, in the words a model should use. Kept as data
 * because it is quoted verbatim in the tool's error text — a rejected call
 * teaches the grammar in the same turn, which is the only documentation a
 * model reliably reads.
 */
export const WHEN_FORMS = [
  '"10 minutes", "2h", "in 45 minutes", "3 days" (relative)',
  '"2026-08-08 10:00", "2026-08-08T10:00:00" (absolute)',
  '"2026-08-08" (date only — 09:00 is assumed)',
  '"9am", "21:30", "noon" (next time it is that o\'clock)',
  '"tomorrow", "tomorrow 9am", "today 5pm"',
] as const;

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  m: 60,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
  d: 86400,
  day: 86400,
  days: 86400,
  w: 604800,
  week: 604800,
  weeks: 604800,
};

const UNIT_ALTERNATION = Object.keys(UNIT_SECONDS)
  .sort((a, b) => b.length - a.length)
  .join("|");

export class WhenParseError extends Error {
  constructor(input: string) {
    super(`could not read "${input}" as a time. Use one of:\n${WHEN_FORMS.map((f) => `  - ${f}`).join("\n")}`);
    this.name = "WhenParseError";
  }
}

/**
 * Resolve a one-shot time expression to an absolute local moment.
 *
 * Order matters. Relative durations are tried first because they are the only
 * form that carries a unit word, then dates, then bare clock times. A bare
 * integer ("10") is deliberately refused rather than guessed: it reads equally
 * as ten minutes and as ten o'clock, and a wake that fires nine hours off is
 * worse than one the model has to phrase again.
 */
export function parseWhen(input: string, now: Date = new Date(), timeZone: string = systemTimeZone()): ParsedWhen {
  const text = input.trim().toLowerCase();
  if (!text) throw new WhenParseError(input);

  const relative = parseRelative(text, now);
  if (relative) return { at: relative, defaultedTime: false };

  const dated = parseAbsolute(text, timeZone);
  if (dated) return dated;

  const dayWord = parseDayWord(text, now, timeZone);
  if (dayWord) return dayWord;

  // Bare number with no unit and no colon — ambiguous, see the doc comment.
  if (/^\d{1,2}$/.test(text)) throw new WhenParseError(input);

  try {
    const { hour, minute } = parseTime(text);
    return { at: nextClockTime(hour, minute, now, timeZone), defaultedTime: false };
  } catch {
    throw new WhenParseError(input);
  }
}

/** "10 minutes", "in 45 minutes", "1h30m", "2 hours 15 minutes". */
function parseRelative(text: string, now: Date): Date | null {
  const body = text.replace(/^in\s+/, "").trim();
  const re = new RegExp(`(\\d+)\\s*(${UNIT_ALTERNATION})\\b`, "g");
  let total = 0;
  let matched = 0;
  for (const m of body.matchAll(re)) {
    total += Number(m[1]) * UNIT_SECONDS[m[2]];
    matched++;
  }
  if (matched === 0) return null;
  // Everything the units did not account for must be filler. "5 minutes past
  // the hour" matches "5 minutes" and leaves "pastthehour" — a phrase this
  // parser does not understand, and reading it as five minutes from now would
  // invent a time the agent did not ask for.
  const leftover = body
    .replace(re, "")
    .replace(/\b(and)\b/g, "")
    .replace(/[\s,]/g, "");
  if (leftover.length > 0) return null;
  return new Date(now.getTime() + total * 1000);
}

/** "2026-08-08", "2026-08-08 10:00", "2026-08-08T10:00:00", "2026-08-08 9am". */
function parseAbsolute(text: string, timeZone: string): ParsedWhen | null {
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[t\s]+(.+))?$/);
  if (!m) return null;
  const [, y, mo, d, rest] = m;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) throw new WhenParseError(text);

  if (!rest || !rest.trim()) {
    return { at: localDate(year, month, day, DEFAULT_HOUR, 0, timeZone), defaultedTime: true };
  }
  // Seconds are accepted and dropped: a wake is scheduled to the minute.
  const clock = rest.trim().replace(/^(\d{1,2}:\d{2}):\d{2}$/, "$1");
  const { hour, minute } = parseTime(clock);
  return { at: localDate(year, month, day, hour, minute, timeZone), defaultedTime: false };
}

/** "tomorrow", "tomorrow 9am", "tomorrow at 9am", "today 5pm". */
function parseDayWord(text: string, now: Date, timeZone: string): ParsedWhen | null {
  const m = text.match(/^(today|tomorrow)(?:\s+(?:at\s+)?(.+))?$/);
  if (!m) return null;
  const base = addCivilDays(zonedParts(now, timeZone), m[1] === "tomorrow" ? 1 : 0);
  if (!m[2]) {
    return {
      at: localDate(base.year, base.month, base.day, DEFAULT_HOUR, 0, timeZone),
      defaultedTime: true,
    };
  }
  const { hour, minute } = parseTime(m[2]);
  return {
    at: localDate(base.year, base.month, base.day, hour, minute, timeZone),
    defaultedTime: false,
  };
}

function localDate(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  return fromZonedParts({ year, month, day, hour, minute, second: 0 }, timeZone);
}

/** The next time it is `hour:minute` — today if that is still ahead, else tomorrow. */
function nextClockTime(hour: number, minute: number, now: Date, timeZone: string): Date {
  let day = zonedParts(now, timeZone);
  let at = localDate(day.year, day.month, day.day, hour, minute, timeZone);
  if (at.getTime() <= now.getTime()) {
    day = addCivilDays(day, 1);
    at = localDate(day.year, day.month, day.day, hour, minute, timeZone);
  }
  return at;
}

// ------------------------------------------------------------------ recurrence

export type Recurrence =
  | { mode: "interval"; seconds: number; source: string }
  | { mode: "cron"; cron: string; source: string };

/** Plain intervals, which cron cannot phase-anchor. See parseEvery. */
const EVERY_INTERVAL = new RegExp(`^every\\s+(\\d+)?\\s*(${UNIT_ALTERNATION})$`);

/**
 * Read a recurrence.
 *
 * Plain intervals ("every 2 hours", "every 3 days") become elapsed time
 * anchored to the start, and everything else — "weekdays at 9am", "every monday
 * at 8:30", raw cron — is handed to `compileSchedule`.
 *
 * The split is not cosmetic. `compileSchedule("every 2 hours")` produces a
 * step-hour cron, which fires on even hours and silently discards the start
 * minute: an agent asking at 10:15 for something every two hours gets 12:00,
 * not 12:15. Cron cannot express phase, so intervals do not go through it.
 * Cron also has no way to say "every 3 days" at all.
 */
export function parseEvery(input: string): Recurrence {
  const source = input.trim();
  if (!source) throw new Error("every is empty");
  const text = source.toLowerCase();

  if (text === "hourly") return { mode: "interval", seconds: 3600, source };
  if (text === "daily") return { mode: "cron", cron: compileSchedule(source).cron, source };

  const m = text.match(EVERY_INTERVAL);
  if (m) {
    const count = m[1] ? Number(m[1]) : 1;
    if (count < 1) throw new Error(`interval must be at least 1, got ${count}`);
    return { mode: "interval", seconds: count * UNIT_SECONDS[m[2]], source };
  }

  return { mode: "cron", cron: compileSchedule(source).cron, source };
}

/**
 * The first occurrence strictly after `after`.
 *
 * Strictly after is what makes an outage cost one wake rather than one per
 * missed period: a schedule three hours overdue advances past now in a single
 * step instead of walking every occurrence it slept through.
 *
 * Returns null when the recurrence has no further occurrence (cron patterns
 * can, e.g. a fixed date that has passed).
 */
export function nextOccurrence(
  rec: Recurrence,
  after: Date,
  anchor?: Date | null,
  timeZone: string = systemTimeZone(),
): Date | null {
  if (rec.mode === "interval") {
    const base = anchor ?? after;
    if (base.getTime() > after.getTime()) return base;
    const elapsed = after.getTime() - base.getTime();
    const step = rec.seconds * 1000;
    const periods = Math.floor(elapsed / step) + 1;
    return new Date(base.getTime() + periods * step);
  }
  return new Cron(rec.cron, { timezone: timeZone }).nextRun(after) ?? null;
}

/**
 * How far apart two consecutive occurrences are, in seconds, so a floor can be
 * enforced before anything is stored. For cron the gap is measured rather than
 * derived: a cron expression has no interval field, so the only way to know how
 * often "0 9 * * 1-5" fires is to ask it twice.
 * Returns null when the pattern has fewer than two occurrences left.
 */
export function occurrenceGapSeconds(rec: Recurrence, from: Date, timeZone: string = systemTimeZone()): number | null {
  if (rec.mode === "interval") return rec.seconds;
  const first = nextOccurrence(rec, from, null, timeZone);
  if (!first) return null;
  const second = nextOccurrence(rec, first, null, timeZone);
  if (!second) return null;
  return Math.round((second.getTime() - first.getTime()) / 1000);
}

// ------------------------------------------------------------------ formatting

/** "Thu Aug 7 at 10:00" — local, for echoing a booking back to the agent. */
export function formatLocal(at: Date, timeZone: string = systemTimeZone()): string {
  return at.toLocaleString("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** "2h 14m", "in 3 days" style distance. Coarse on purpose — this is prose. */
export function formatDistance(ms: number): string {
  const abs = Math.abs(ms);
  const mins = Math.round(abs / 60_000);
  if (mins < 1) return "under a minute";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24) return rem ? `${hours}h ${rem}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH ? `${days}d ${remH}h` : `${days}d`;
}
