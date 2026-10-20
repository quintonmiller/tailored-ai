/**
 * A calendar on a wall: when agents next wake, and what each will do then.
 * In a home, its owner's day: the wakes it booked with the `schedule` tool,
 * the cron jobs that run as it, its next turn when it runs on its own, and
 * what it got done today. In the lobby, everyone's next wakes in time order.
 * Which lines go on the page is worked out here, without a canvas, so it is
 * tested; the drawing only lays them out.
 */
import { nameOf } from "../lib/conversations";
import { pastTense } from "../lib/did";
import { whenMs } from "../lib/tasks";
import { nextTurn, type OwnTurns } from "../lib/wakes";
import type { AgentActivity } from "./doing";

/** A wake an agent booked with the `schedule` tool, as `GET /api/schedules` sends it. */
export interface Booked {
  id: string;
  agent: string;
  note: string;
  kind: "once" | "repeat";
  /** How it repeats, in the words it was booked with. */
  every: string | null;
  next_run_at: string | null;
  target_kind: "room" | "session";
  target: string;
}

/** A cron job, as `GET /api/cron` sends it. */
export interface CronJob {
  name: string;
  /** The agent it runs as; none is the default agent. */
  agent: string | null;
  task: string;
  schedule: string;
  enabled: number;
  next_run?: string | null;
}

/** An agent that runs on its own, as `GET /api/exploratory/agents` sends it. */
export interface OwnAgent extends OwnTurns {
  name: string;
}

/** What wakes an agent next, and when. */
export interface Wake {
  key: string;
  agent: string;
  at: number;
  /** Booked with the `schedule` tool, a cron job, or its own turn. */
  kind: "booked" | "cron" | "turn";
  /** What it will do, in a line. */
  what: string;
  /** In full: a booked wake's note, a cron job's prompt. */
  detail?: string;
  /** How often it comes round again: "weekdays at 9am", "every 30 min". */
  every?: string;
  /** The room a booked wake wakes it in, by ref; none when it wakes in its own conversation. */
  room?: string;
}

/** Something an agent got done today. */
export interface Done {
  key: string;
  agent: string;
  at: number;
  what: string;
  /** The task it finished, by id. */
  task?: string;
}

/** How far ahead a calendar looks. Past a week it is not a day's plan any more. */
export const HORIZON_MS = 7 * 86_400_000;

const firstLine = (s: string) =>
  s
    .split("\n")
    .find((l) => l.trim())
    ?.trim() ?? "";

/** Every minute as "every 30 min", "every 2 h", "every day". */
function everyWords(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `every ${min} min`;
  if (min % 1440 === 0) return min === 1440 ? "every day" : `every ${min / 1440} days`;
  return min % 60 === 0 ? `every ${min / 60} h` : `every ${min} min`;
}

/**
 * Every wake to come within the week, soonest first: the booked ones, the
 * cron jobs while cron is on, and each agent's next turn of its own while the
 * worker that takes them is on. A booked wake that is overdue (agents are
 * paused, say) is still to come, so it stays, at the time it was due.
 */
export function upcoming(
  from: {
    booked: Booked[];
    cron: CronJob[];
    /** Whether cron runs at all. */
    cronOn: boolean;
    own: OwnAgent[];
    /** Whether agents that run on their own are being run. */
    ownOn: boolean;
  },
  now = Date.now(),
): Wake[] {
  const until = now + HORIZON_MS;
  const out: Wake[] = [];
  for (const b of from.booked) {
    const at = whenMs(b.next_run_at);
    if (!Number.isFinite(at) || at > until) continue;
    out.push({
      key: `booked:${b.id}`,
      agent: b.agent,
      at,
      kind: "booked",
      what: firstLine(b.note) || "a wake it booked",
      detail: b.note,
      ...(b.kind === "repeat" && b.every ? { every: b.every } : {}),
      ...(b.target_kind === "room" ? { room: b.target } : {}),
    });
  }
  if (from.cronOn)
    for (const job of from.cron) {
      const at = whenMs(job.next_run);
      if (!job.enabled || !Number.isFinite(at) || at > until) continue;
      out.push({
        key: `cron:${job.name}`,
        agent: job.agent || "default",
        at,
        kind: "cron",
        what: job.name.replace(/[-_]+/g, " "),
        detail: job.task,
        every: job.schedule,
      });
    }
  if (from.ownOn)
    for (const agent of from.own) {
      const next = nextTurn(agent, now);
      if (next.kind !== "due" || next.at > until) continue;
      // Within the hours it keeps to, when it keeps to some: "every 30 min, 09:00–17:00".
      const hours = agent.cadence?.window ? `, ${agent.cadence.window.start}–${agent.cadence.window.end}` : "";
      out.push({
        key: `turn:${agent.name}`,
        agent: agent.name,
        at: next.at,
        kind: "turn",
        what: "its own turn",
        ...(next.every ? { every: `${everyWords(next.every)}${hours}` } : {}),
      });
    }
  return out.sort((a, b) => a.at - b.at || a.agent.localeCompare(b.agent));
}

/** Midnight at the start of the day `at` falls in, on the page's clock. */
export function dayStart(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The day after `start`, at its midnight: a day is not always 24 hours long where clocks change. */
const nextDay = (start: number) => dayStart(start + 36 * 3_600_000);

/** A task, as far as what got done today needs one. */
export interface DoneTask {
  id: string;
  title: string;
  status: string;
  assignee?: string | null;
  updated_at?: string;
}

/**
 * What agents got done today, newest first: the tasks they finished (done,
 * and last changed today), and the last thing each did, when that was today.
 */
export function doneToday(tasks: DoneTask[], activities: Record<string, AgentActivity>, now = Date.now()): Done[] {
  const today = dayStart(now);
  // Today on the page's clock, start to end: `now` may be a minute behind what was just done.
  const isToday = (at: number) => at >= today && at < nextDay(today);
  const out: Done[] = [];
  for (const t of tasks) {
    const at = whenMs(t.updated_at);
    if (t.status !== "done" || !t.assignee || !isToday(at)) continue;
    out.push({ key: `task:${t.id}`, agent: t.assignee, at, what: `finished “${t.title}”`, task: t.id });
  }
  for (const [agent, a] of Object.entries(activities)) {
    const at = whenMs(a.last?.at);
    if (!a.last?.what || !isToday(at)) continue;
    out.push({ key: `last:${agent}`, agent: a.agent || agent, at, what: pastTense(a.last.what) });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** A day's wakes under its heading: "Today", "Tomorrow", "Wed 21 Oct". */
export interface Day {
  label: string;
  start: number;
  wakes: Wake[];
}

/** Wakes grouped by the day they fall on, in order. Anything overdue goes under today. */
export function byDay(
  wakes: Wake[],
  now = Date.now(),
  dayName = (at: number) => new Date(at).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }),
): Day[] {
  const today = dayStart(now);
  const tomorrow = nextDay(today);
  const days: Day[] = [];
  for (const wake of wakes) {
    const start = Math.max(today, dayStart(wake.at));
    let day = days.at(-1);
    if (!day || day.start !== start) {
      day = {
        label: start === today ? "Today" : start === tomorrow ? "Tomorrow" : dayName(start),
        start,
        wakes: [],
      };
      days.push(day);
    }
    day.wakes.push(wake);
  }
  return days;
}

/**
 * Tasks finished between `from` and `to`, newest first: done, assigned, and
 * last changed in that time. What a calendar read close up puts on the days
 * gone by of its week and its month.
 */
export function doneBetween(tasks: DoneTask[], from: number, to: number): Done[] {
  const out: Done[] = [];
  for (const t of tasks) {
    const at = whenMs(t.updated_at);
    if (t.status !== "done" || !t.assignee || !(at >= from && at < to)) continue;
    out.push({ key: `task:${t.id}`, agent: t.assignee, at, what: `finished “${t.title}”`, task: t.id });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** How a calendar read close up lays out its days: today alone, the week from today, or the month. */
export type CalendarMode = "day" | "week" | "month";

/** A day on a calendar's week or month: its midnight, and whether it is today and in the month shown. */
export interface CalendarDay {
  start: number;
  today: boolean;
  /** In the month the calendar shows, rather than the end of the month before or the start of the next. */
  inMonth: boolean;
}

/**
 * The days a calendar shows in a mode: today; today and the six days after;
 * or the month's weeks from the week its first day is in, each starting on
 * `firstDay` (0 Sunday, 1 Monday), whole weeks only.
 */
export function calendarDays(mode: CalendarMode, now = Date.now(), firstDay = 1): CalendarDay[] {
  const today = dayStart(now);
  const month = new Date(today).getMonth();
  const at = (start: number): CalendarDay => ({
    start,
    today: start === today,
    inMonth: new Date(start).getMonth() === month,
  });
  if (mode === "day") return [at(today)];
  const out: CalendarDay[] = [];
  if (mode === "week") {
    for (let d = today, i = 0; i < 7; i++, d = nextDay(d)) out.push(at(d));
    return out;
  }
  const first = new Date(today);
  first.setDate(1);
  const back = (first.getDay() - firstDay + 7) % 7;
  first.setDate(1 - back);
  let d = dayStart(first.getTime());
  // Weeks until one starts after the month has ended.
  while (out.length < 42) {
    if (out.length % 7 === 0 && out.length && new Date(d).getMonth() !== month && d > today) break;
    out.push(at(d));
    d = nextDay(d);
  }
  return out;
}

/** What falls on the day starting at `start`: its wakes, soonest first, and what got done, newest first. */
export function onDay(start: number, wakes: Wake[], done: Done[]): { wakes: Wake[]; done: Done[] } {
  const end = nextDay(start);
  return {
    wakes: wakes.filter((w) => w.at >= start && w.at < end).sort((a, b) => a.at - b.at),
    done: done.filter((d) => d.at >= start && d.at < end).sort((a, b) => b.at - a.at),
  };
}

/** What a calendar shows. */
export interface CalendarView {
  /** Whose it is, under the date: "planner's day", "Everyone's next wakes". */
  title: string;
  /** Now, on the page's clock: the date at the top, and which day is today. */
  now: number;
  wakes: Wake[];
  done: Done[];
  /** Each line says whose wake it is: in the lobby, where they are everyone's. */
  names: boolean;
  /** A line under the title when nothing will wake on time for a reason: agents are paused. */
  note?: string;
  /** What got done this month and last, for the days gone by when it is read close up: newest first. */
  history?: Done[];
}

/** A line on a calendar's page. */
export type CalendarLine =
  | { kind: "day"; text: string }
  | { kind: "wake"; wake: Wake }
  | { kind: "done-head" }
  | { kind: "done"; done: Done }
  | { kind: "more"; count: number }
  | { kind: "empty"; text: string };

/** Lines of what got done kept at the foot of a page, at most, when there is any. */
const DONE_LINES = 2;
/** Lines a page keeps for its wakes before it gives any to what got done: a day's heading, two wakes, a count. */
const WAKE_LINES = 4;

/**
 * The lines that fit on a page `room` lines long: each day's heading and its
 * wakes, and, kept at the foot, a heading and the latest of what got done
 * today. Wakes that don't fit end in a line saying how many more there are.
 */
export function calendarLines(view: CalendarView, room: number, dayName?: (at: number) => string): CalendarLine[] {
  const done = view.done.slice(0, Math.min(DONE_LINES, Math.max(0, room - WAKE_LINES - 1)));
  const foot: CalendarLine[] = done.length
    ? [{ kind: "done-head" }, ...done.map((d) => ({ kind: "done" as const, done: d }))]
    : [];
  const space = room - foot.length;
  const lines: CalendarLine[] = [];
  const days = byDay(view.wakes, view.now, dayName);
  if (!days.length) lines.push({ kind: "empty", text: "Nothing booked" });
  const total = view.wakes.length;
  let shown = 0;
  for (const day of days) {
    // A heading goes on only with a wake under it, and room after that for the count of any left.
    if (lines.length + 2 + (total - shown > 1 ? 1 : 0) > space) break;
    lines.push({ kind: "day", text: day.label });
    let put = 0;
    for (const wake of day.wakes) {
      // Each wake leaves room for the count of the rest, unless it is the last of all.
      if (lines.length + 1 + (total - shown > 1 ? 1 : 0) > space) break;
      lines.push({ kind: "wake", wake });
      shown++;
      put++;
    }
    if (put < day.wakes.length) break;
  }
  if (shown < total) lines.push({ kind: "more", count: total - shown });
  return [...lines, ...foot];
}

// --------------------------------------------------------------------------
// Drawing
// --------------------------------------------------------------------------

/** The colour of the dot before a wake: booked, a cron job, or a turn of its own. */
const KIND_COLORS: Record<Wake["kind"], string> = { booked: "#3d7be0", cron: "#8a5cc7", turn: "#7a8394" };
const PAPER = "#fbfaf6";
const INK = "#2b2f38";
const DIM = "#6b7180";
const BAND = "#c4483a";

/** `s` cut with an ellipsis to fit `width` pixels in the context's font. */
function clip(ctx: CanvasRenderingContext2D, s: string, width: number): string {
  if (ctx.measureText(s).width <= width) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${s.slice(0, mid).trimEnd()}…`).width <= width) lo = mid;
    else hi = mid - 1;
  }
  return `${s.slice(0, lo).trimEnd()}…`;
}

/** The time of a wake as the page's clock says it. */
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * Draw a calendar: today's date large on a coloured band, whose it is, then
 * each day's wakes (the time, a dot for what kind of wake, whose in the lobby,
 * what it will do), and what got done today at the foot. With nothing to show
 * yet, or in a photo, which is never told, only the date: an empty page says
 * nothing untrue, where "Nothing booked" might.
 */
export function drawCalendar(canvas: HTMLCanvasElement, view: CalendarView | undefined, now = Date.now()) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { width: w, height: h } = canvas;
  const font = (weight: number, size: number) => `${weight} ${Math.round(size)}px system-ui, sans-serif`;
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, w, h);
  const pad = w * 0.05;
  const band = h * 0.19;
  ctx.fillStyle = BAND;
  ctx.fillRect(0, 0, w, band);
  const today = new Date(view?.now ?? now);
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillStyle = "#fff";
  ctx.font = font(800, band * 0.72);
  const day = String(today.getDate());
  ctx.fillText(day, pad, band * 0.54);
  const dayW = ctx.measureText(day).width;
  ctx.font = font(700, band * 0.27);
  ctx.fillText(today.toLocaleDateString([], { weekday: "long" }), pad + dayW + pad * 0.6, band * 0.36);
  ctx.font = font(500, band * 0.22);
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillText(today.toLocaleDateString([], { month: "long", year: "numeric" }), pad + dayW + pad * 0.6, band * 0.68);
  if (!view) return;
  let y = band + h * 0.05;
  ctx.fillStyle = INK;
  ctx.font = font(700, h * 0.052);
  ctx.fillText(clip(ctx, view.title, w - pad * 2), pad, y);
  y += h * 0.055;
  if (view.note) {
    ctx.fillStyle = "#b5552a";
    ctx.font = font(600, h * 0.038);
    ctx.fillText(clip(ctx, view.note, w - pad * 2), pad, y);
    y += h * 0.05;
  }
  // A few lines, big enough to read from a step or two back: the rest is in the list a click opens. A home's, whose
  // lines say no names, has fewer and bigger ones, to read from the agent's own view, where there is no walking up.
  const lineH = h * (view.names ? 0.095 : 0.13);
  const room = Math.max(3, Math.floor((h - pad * 0.6 - y) / lineH));
  // As wide as the widest time the page's clock writes: "22:58", or "10:58 PM" where it counts in twelves.
  const timeW = (() => {
    ctx.font = font(700, lineH * 0.56);
    return ctx.measureText(clock(new Date(2020, 0, 1, 22, 58).getTime())).width + lineH * 0.25;
  })();
  for (const line of calendarLines(view, room)) {
    const mid = y + lineH / 2;
    if (line.kind === "day" || line.kind === "done-head") {
      ctx.fillStyle = DIM;
      ctx.font = font(700, lineH * 0.46);
      const label = line.kind === "day" ? line.text.toUpperCase() : "DONE TODAY";
      ctx.fillText(label, pad, mid + lineH * 0.08);
      const lw = ctx.measureText(label).width;
      ctx.fillRect(
        pad + lw + lineH * 0.25,
        mid + lineH * 0.08,
        w - pad * 2 - lw - lineH * 0.25,
        Math.max(1, h * 0.002),
      );
    } else if (line.kind === "wake") {
      const { wake } = line;
      ctx.fillStyle = INK;
      ctx.font = font(700, lineH * 0.56);
      ctx.fillText(clock(wake.at), pad, mid);
      ctx.beginPath();
      ctx.arc(pad + timeW + lineH * 0.12, mid, lineH * 0.12, 0, Math.PI * 2);
      ctx.fillStyle = KIND_COLORS[wake.kind];
      ctx.fill();
      let x = pad + timeW + lineH * 0.42;
      // Whose it is, where it is everyone's, a little smaller, so what it will do still has room.
      const size = view.names ? lineH * 0.5 : lineH * 0.56;
      if (view.names) {
        ctx.fillStyle = BAND;
        ctx.font = font(700, size);
        const who = clip(ctx, nameOf(wake.agent), w * 0.24);
        ctx.fillText(who, x, mid);
        x += ctx.measureText(who).width + lineH * 0.25;
      }
      ctx.fillStyle = INK;
      ctx.font = font(500, size);
      ctx.fillText(clip(ctx, wake.what, w - pad - x), x, mid);
    } else if (line.kind === "done") {
      ctx.fillStyle = "#3f8f4e";
      ctx.font = font(700, lineH * 0.52);
      ctx.fillText("✓", pad, mid);
      ctx.fillStyle = INK;
      ctx.font = font(500, lineH * 0.54);
      const who = view.names ? `${nameOf(line.done.agent)} ` : "";
      ctx.fillText(clip(ctx, `${who}${line.done.what}`, w - pad * 2 - timeW), pad + timeW, mid);
    } else if (line.kind === "more") {
      ctx.fillStyle = DIM;
      ctx.font = font(500, lineH * 0.46);
      ctx.fillText(`+${line.count} more`, pad + timeW, mid);
    } else {
      ctx.fillStyle = DIM;
      ctx.font = `italic ${font(400, lineH * 0.5)}`;
      ctx.fillText(line.text, pad, mid);
    }
    y += lineH;
  }
}
