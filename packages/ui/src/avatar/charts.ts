/**
 * The charts on the walls of the 3D world: small, honest charts of numbers
 * the server keeps (`GET /api/ext/builtin:activity/stats`), by the day on
 * the page's own clock. Worked out here without a page, so it is tested:
 * which measure a chart shows, each day's total from the server's hours,
 * a scale with round ticks, and time by activity as bars. Nothing is made
 * up: a day with nothing is a zero, and time by activity says from when it
 * was counted.
 */
import type { ScreenCard } from "./screens";

/** What a chart can show. */
export type Measure = "tokens" | "turns" | "tasks" | "time";

export const MEASURES: { id: Measure; title: string; short: string }[] = [
  { id: "tokens", title: "Tokens per day", short: "Tokens" },
  { id: "turns", title: "Turns per day", short: "Turns" },
  { id: "tasks", title: "Tasks done per day", short: "Tasks done" },
  { id: "time", title: "Time by activity", short: "Time" },
];

const MEASURE_WORDS: Record<string, Measure> = {
  tokens: "tokens",
  token: "tokens",
  usage: "tokens",
  turns: "turns",
  turn: "turns",
  tasks: "tasks",
  task: "tasks",
  "tasks done": "tasks",
  done: "tasks",
  time: "time",
  "time by activity": "time",
  activity: "time",
};

/** The measure some words name: "tokens", "Tasks done", "time"; none when they name none. */
export function measureOf(words: string | undefined): Measure | undefined {
  return words ? MEASURE_WORDS[words.trim().toLowerCase().replace(/\s+/g, " ")] : undefined;
}

/** What the server sends: numbers by agent and UTC hour. */
export interface StatsData {
  days: number;
  tokens: { hour: string; agent: string; prompt: number; completion: number; calls: number }[];
  turns: { hour: string; agent: string; n: number }[];
  done: { hour: string; agent: string; n: number }[];
  time: { hour: string; agent: string; what: string; ms: number }[];
  /** Since when time by activity was counted. */
  since: string;
}

/** A day on a chart: its midnight on the page's clock, and what the axis calls it. */
export interface ChartDay {
  start: number;
  label: string;
}

/** The last `count` days on the page's clock, oldest first, ending with today. */
export function lastDays(count: number, now = Date.now()): ChartDay[] {
  const out: ChartDay[] = [];
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  for (let i = 0; i < count; i++) {
    out.unshift({
      start: d.getTime(),
      label: i === 0 ? "Today" : d.toLocaleDateString([], count > 7 ? { day: "numeric" } : { weekday: "short" }),
    });
    d.setDate(d.getDate() - 1);
  }
  return out;
}

/** The index of the day an hour falls in, of `days`; -1 when it falls in none of them. */
function dayIndex(hour: string, days: ChartDay[]): number {
  const at = Date.parse(hour);
  if (!Number.isFinite(at) || !days.length) return -1;
  for (let i = days.length - 1; i >= 0; i--) if (at >= (days[i]?.start ?? 0)) return i;
  return -1;
}

/** Each day's sum of `value` over the rows of the agents asked about (all, when none are named). */
export function perDay<R extends { hour: string; agent: string }>(
  rows: R[],
  value: (row: R) => number,
  days: ChartDay[],
  who?: string[],
): number[] {
  const out = days.map(() => 0);
  for (const r of rows) {
    if (who && !who.includes(r.agent)) continue;
    const i = dayIndex(r.hour, days);
    if (i >= 0) out[i] = (out[i] ?? 0) + value(r);
  }
  return out;
}

/** One series of bars on a chart: what it is, the colour it is drawn in, a number for each day. */
export interface Series {
  key: string;
  label: string;
  /** A colour the chart's styles name: `--chart-1` and on. */
  tone: 1 | 2 | 3;
  values: number[];
}

/** A chart of a number per day: one series, or two stacked (tokens in and out). */
export interface DayChart {
  measure: Exclude<Measure, "time">;
  days: ChartDay[];
  series: Series[];
  /** The whole period, and today alone. */
  total: number;
  today: number;
}

/** The chart of a measure by the day, for the last `count` days, of some agents or all. */
export function dayChart(
  stats: StatsData,
  measure: Exclude<Measure, "time">,
  count: number,
  now = Date.now(),
  who?: string[],
): DayChart {
  const days = lastDays(count, now);
  const series: Series[] =
    measure === "tokens"
      ? [
          { key: "prompt", label: "Read", tone: 1, values: perDay(stats.tokens, (r) => r.prompt, days, who) },
          {
            key: "completion",
            label: "Written",
            tone: 2,
            values: perDay(stats.tokens, (r) => r.completion, days, who),
          },
        ]
      : measure === "turns"
        ? [{ key: "turns", label: "Turns", tone: 1, values: perDay(stats.turns, (r) => r.n, days, who) }]
        : [{ key: "done", label: "Done", tone: 3, values: perDay(stats.done, (r) => r.n, days, who) }];
  const sums = days.map((_, i) => series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  return {
    measure,
    days,
    series,
    total: sums.reduce((a, b) => a + b, 0),
    today: sums.at(-1) ?? 0,
  };
}

/** A scale for an axis: its top, the step between ticks, and the ticks from zero up. */
export interface Scale {
  max: number;
  step: number;
  ticks: number[];
}

/**
 * A scale from zero that holds `max`, in about `ticks` round steps (1, 2,
 * 2.5 or 5 times a power of ten): a top of 1 when everything is zero, so an
 * empty chart still has an axis.
 */
export function niceScale(max: number, ticks = 4): Scale {
  if (!(max > 0)) return { max: 1, step: 1, ticks: [0, 1] };
  const rough = max / ticks;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * power >= rough) ?? 10) * power;
  const top = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return { max: top, step, ticks: out };
}

/** A number in a few characters for an axis or a total: 950, 1.2k, 34k, 1.5M. */
export function shortNumber(n: number): string {
  const a = Math.abs(n);
  const cut = (v: number, unit: string) => `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10}${unit}`;
  if (a >= 1e9) return cut(n / 1e9, "B");
  if (a >= 1e6) return cut(n / 1e6, "M");
  if (a >= 1e3) return cut(n / 1e3, "k");
  return `${Math.round(n)}`;
}

/** A length of time in a few words: "45 s", "12 min", "2 h 10 min". */
export function durationWords(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))} s`;
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

/** One bar of time by activity: what it was, and how long. */
export interface TimeBar {
  what: string;
  ms: number;
}

/** Bars time by activity shows before the rest are summed as "everything else". */
const TIME_BARS = 6;

/**
 * Time by activity over the days given, of some agents or all: the longest
 * first, the rest summed as "everything else", and since when it was
 * counted, when that was after the first of those days began.
 */
export function timeChart(
  stats: StatsData,
  days: ChartDay[],
  who?: string[],
  bars = TIME_BARS,
): { bars: TimeBar[]; total: number; since?: number } {
  const by = new Map<string, number>();
  for (const r of stats.time) {
    if (who && !who.includes(r.agent)) continue;
    if (dayIndex(r.hour, days) < 0) continue;
    by.set(r.what, (by.get(r.what) ?? 0) + r.ms);
  }
  const all = [...by.entries()].map(([what, ms]) => ({ what, ms })).sort((a, b) => b.ms - a.ms);
  const kept = all.slice(0, all.length > bars ? bars - 1 : bars);
  const rest = all.slice(kept.length).reduce((s, b) => s + b.ms, 0);
  const since = Date.parse(stats.since);
  return {
    bars: rest ? [...kept, { what: "everything else", ms: rest }] : kept,
    total: all.reduce((s, b) => s + b.ms, 0),
    ...(Number.isFinite(since) && since > (days[0]?.start ?? 0) ? { since } : {}),
  };
}

/** A chart from across a room: the measure, today's number and the period's. */
export function chartGlance(
  stats: StatsData | undefined,
  measure: Measure,
  now = Date.now(),
  who?: string[],
): ScreenCard {
  const title = MEASURES.find((m) => m.id === measure)?.title ?? "Chart";
  const card: ScreenCard = { id: "chart", title };
  if (!stats) return { ...card, empty: "Loading…" };
  if (measure === "time") {
    const t = timeChart(stats, lastDays(1, now), who);
    if (!t.total) return { ...card, empty: "Nothing counted yet today" };
    return {
      ...card,
      big: { text: durationWords(t.total), sub: "busy today" },
      rows: t.bars.slice(0, 3).map((b) => ({ text: b.what, meta: durationWords(b.ms) })),
    };
  }
  const c = dayChart(stats, measure, 7, now, who);
  return {
    ...card,
    big: { text: shortNumber(c.today), sub: `today · ${shortNumber(c.total)} this week` },
  };
}
