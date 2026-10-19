/**
 * When the exploratory worker next takes an agent's turn on its own, worked
 * out the way it decides: its last turn plus the interval it is on, once the
 * day's limit lifts, within its hours. Shared by everything that shows it
 * (the activity record, `GET /api/exploratory/agents`), so none of them
 * guesses a time the worker won't keep.
 */
import type { OnlineAgentConfig } from "../config.js";
import { isInTimeWindow } from "../db/autopilot-queries.js";
import type { ExploratoryState } from "../db/exploratory-queries.js";
import { systemTimeZone } from "../time/provider.js";
import { zonedParts } from "../time/zoned.js";
import { tickIntervalMs } from "./worker.js";

/** How an agent that runs on its own keeps time. */
export interface OwnTurns {
  /** Its last turn; null before its first. */
  last: string | null;
  /** The interval it is on. */
  intervalMs: number;
  /** The hours it keeps to, as HH:MM in `timeZone`: a turn due outside them waits for them to start. */
  window?: { start: string; end: string };
  timeZone?: string;
  /** It has had all the turns it may today: none before this. */
  notBefore?: string;
}

/**
 * How an agent keeps time for its turns, from its state and its `online:`
 * block; null while it takes none (switched off, or paused). Its turns for
 * the day are counted against the store's date, in UTC: once they run out,
 * none till the next.
 */
export function ownTurnsOf(
  state: Pick<
    ExploratoryState,
    "enabled" | "paused_until" | "last_tick_at" | "current_interval_ms" | "runs_today" | "tokens_today_resets_at"
  >,
  online: Pick<OnlineAgentConfig, "cadence" | "budgets">,
  timeZone: string,
  now: Date,
): OwnTurns | null {
  if (!state.enabled || (state.paused_until && new Date(state.paused_until) > now)) return null;
  const today = now.toISOString().slice(0, 10);
  const cap = online.budgets?.stop_after_runs_per_day;
  const spent = cap !== undefined && state.tokens_today_resets_at === today && state.runs_today >= cap;
  return {
    last: state.last_tick_at,
    intervalMs: tickIntervalMs(state, online),
    ...(online.cadence?.window ? { window: online.cadence.window, timeZone } : {}),
    ...(spent
      ? { notBefore: `${new Date(Date.parse(today) + 86_400_000).toISOString().slice(0, 10)}T00:00:00.000Z` }
      : {}),
  };
}

/**
 * Its next turn, in ms: its last turn plus the interval it is on (or now,
 * before its first, which the worker takes at its next look), once the day's
 * limit lifts, within its hours. Due outside its hours, or overdue while they
 * are over, it is when they next start. Undefined when its hours never come.
 */
export function nextOwnTurn(own: OwnTurns, now: number): number | undefined {
  if (!(own.intervalMs > 0)) return undefined;
  const last = own.last ? Date.parse(own.last) : Number.NaN;
  const lifts = own.notBefore ? Date.parse(own.notBefore) : Number.NaN;
  const due = Math.max(Number.isFinite(last) ? last + own.intervalMs : now, Number.isFinite(lifts) ? lifts : 0);
  if (!own.window) return due;
  const { start, end } = own.window;
  const opens = minuteOfDay(start);
  if (opens === undefined || minuteOfDay(end) === undefined || opens === minuteOfDay(end)) return undefined;
  // The worker takes a turn at its first look once it is due: then, or now if that has passed.
  const from = Math.max(due, now);
  if (isInTimeWindow(start, end, new Date(from), own.timeZone)) return due;
  // The next time the clock reads the window's start, to the minute: the same answer for every look until then.
  const local = zonedParts(new Date(from), own.timeZone ?? systemTimeZone());
  const wait = (opens - (local.hour * 60 + local.minute) + 1440) % 1440 || 1440;
  return Math.floor(from / 60_000) * 60_000 + wait * 60_000;
}

/** An HH:MM time as minutes into the day, the way the worker reads its window; undefined when it isn't one. */
function minuteOfDay(hm: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? h * 60 + min : undefined;
}
