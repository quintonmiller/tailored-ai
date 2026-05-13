/**
 * Friendly schedule DSL → cron compiler. Lets users write
 *
 *   every 30 minutes
 *   every day at 9am
 *   weekdays at 5pm
 *   every monday at 8:30
 *
 * instead of memorising cron syntax. Output is always a 5-token cron expression
 * understood by `croner`. Bare cron strings pass through unchanged.
 *
 * Out of scope: one-shot timestamps ("in 3 days", "at 2026-06-01T09:00") — those
 * need scheduler support and don't fit a cron token. Tracked separately.
 */

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DAY_SHORT: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

export interface CompiledSchedule {
  /** The 5-token cron expression usable by croner. */
  cron: string;
  /** True if the input was already cron syntax (passed through). */
  passthrough: boolean;
  /** Original input, trimmed. */
  source: string;
}

/**
 * Best-effort compile of a DSL string into a cron expression. Returns a
 * descriptive Error when nothing matches. Inputs that already look like cron
 * (5 or 6 whitespace-separated tokens) are returned verbatim.
 */
export function compileSchedule(input: string): CompiledSchedule {
  const source = input.trim();
  if (!source) throw new Error("schedule is empty");
  if (looksLikeCron(source)) {
    return { cron: source, passthrough: true, source };
  }
  const cron = parseDsl(source.toLowerCase());
  return { cron, passthrough: false, source };
}

/**
 * Convenience wrapper that returns the cron string directly. Throws on parse
 * errors so call sites surface them at config-validation time.
 */
export function scheduleToCron(input: string): string {
  return compileSchedule(input).cron;
}

function looksLikeCron(text: string): boolean {
  const parts = text.split(/\s+/);
  if (parts.length !== 5 && parts.length !== 6) return false;
  // Cron tokens use digits, *, /, -, ,. If any token is a recognizable English
  // word (like "every" or "day"), it's the DSL, not cron.
  return parts.every((p) => /^[0-9*,/\-?LW#]+$/i.test(p));
}

function parseDsl(text: string): string {
  // "every N minutes" / "every minute"
  const everyMin = text.match(/^every\s+(\d+)\s*min(?:ute)?s?$/);
  if (everyMin) {
    const n = Number(everyMin[1]);
    if (n < 1 || n > 59) throw new Error(`minute interval must be 1..59, got ${n}`);
    return `*/${n} * * * *`;
  }
  if (text === "every minute") return "* * * * *";

  // "every N hours" / "every hour"
  const everyHour = text.match(/^every\s+(\d+)\s*hours?$/);
  if (everyHour) {
    const n = Number(everyHour[1]);
    if (n < 1 || n > 23) throw new Error(`hour interval must be 1..23, got ${n}`);
    return `0 */${n} * * *`;
  }
  if (text === "every hour" || text === "hourly") return "0 * * * *";

  // "every day at <time>"
  let m = text.match(/^(?:every\s+day|daily)\s+at\s+(.+)$/);
  if (m) {
    const { hour, minute } = parseTime(m[1]);
    return `${minute} ${hour} * * *`;
  }

  // "weekdays at <time>" / "every weekday at <time>"
  m = text.match(/^(?:every\s+)?weekdays?\s+at\s+(.+)$/);
  if (m) {
    const { hour, minute } = parseTime(m[1]);
    return `${minute} ${hour} * * 1-5`;
  }

  // "weekends at <time>" / "every weekend at <time>"
  m = text.match(/^(?:every\s+)?weekends?\s+at\s+(.+)$/);
  if (m) {
    const { hour, minute } = parseTime(m[1]);
    return `${minute} ${hour} * * 0,6`;
  }

  // "every <dayname> at <time>"
  m = text.match(/^(?:every\s+)?(sun|mon|tue|wed|thu|fri|sat)\w*\s+at\s+(.+)$/);
  if (m) {
    const day = DAY_SHORT[m[1]];
    const { hour, minute } = parseTime(m[2]);
    return `${minute} ${hour} * * ${day}`;
  }

  // "every <full day name> at <time>" — also supported by the short prefix above
  for (let i = 0; i < DAY_NAMES.length; i++) {
    const re = new RegExp(`^(?:every\\s+)?${DAY_NAMES[i]}s?\\s+at\\s+(.+)$`);
    const dm = text.match(re);
    if (dm) {
      const { hour, minute } = parseTime(dm[1]);
      return `${minute} ${hour} * * ${i}`;
    }
  }

  // "at <time>" — shorthand for "every day at <time>"
  m = text.match(/^at\s+(.+)$/);
  if (m) {
    const { hour, minute } = parseTime(m[1]);
    return `${minute} ${hour} * * *`;
  }

  throw new Error(`could not parse schedule DSL: "${text}"`);
}

function parseTime(text: string): { hour: number; minute: number } {
  const t = text.trim().toLowerCase();
  // "9am", "12pm", "5 pm"
  let m = t.match(/^(\d{1,2})\s*(am|pm)$/);
  if (m) {
    let h = Number(m[1]);
    if (h < 1 || h > 12) throw new Error(`hour must be 1..12 with am/pm, got ${h}`);
    if (m[2] === "am" && h === 12) h = 0;
    else if (m[2] === "pm" && h !== 12) h += 12;
    return { hour: h, minute: 0 };
  }
  // "9:30am", "11:45 pm"
  m = t.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/);
  if (m) {
    let h = Number(m[1]);
    const min = Number(m[2]);
    if (h < 1 || h > 12) throw new Error(`hour must be 1..12 with am/pm, got ${h}`);
    if (min > 59) throw new Error(`minute must be 0..59, got ${min}`);
    if (m[3] === "am" && h === 12) h = 0;
    else if (m[3] === "pm" && h !== 12) h += 12;
    return { hour: h, minute: min };
  }
  // "14:30", "09:00"
  m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23) throw new Error(`hour must be 0..23, got ${h}`);
    if (min > 59) throw new Error(`minute must be 0..59, got ${min}`);
    return { hour: h, minute: min };
  }
  // bare hour, treated as 24h "14" = 14:00
  m = t.match(/^(\d{1,2})$/);
  if (m) {
    const h = Number(m[1]);
    if (h > 23) throw new Error(`hour must be 0..23 (or use am/pm), got ${h}`);
    return { hour: h, minute: 0 };
  }
  // "noon" / "midnight"
  if (t === "noon") return { hour: 12, minute: 0 };
  if (t === "midnight") return { hour: 0, minute: 0 };
  throw new Error(`could not parse time: "${text}"`);
}
