/**
 * The widgets on the walls of the 3D world (`WidgetFaces.tsx`): live pages
 * that show what the server keeps, each its own kind of thing to hang. What
 * can be worked out without a page is here, so it is tested: which widget a
 * thing shows, who is doing what, the feed and its filters, a board's
 * filters and load, a photo wall's slideshow, a ticker's lines, the day's
 * agenda, and the picture each draws of itself from across a room (a
 * `ScreenCard`, drawn as a screen's page is).
 */
import { nameOf } from "../lib/conversations";
import { clockTime, pastTense } from "../lib/did";
import type { Need } from "../lib/needs";
import { ago, GROUPS, lasting, whenMs } from "../lib/tasks";
import type { BoardTask } from "./boards";
import type { Done, Wake } from "./calendar";
import { chartGlance, MEASURES, type Measure, measureOf, type StatsData } from "./charts";
import type { AgentActivity } from "./doing";
import { isOut } from "./routines";
import type { ScreenCard, ScreenRow, Tone } from "./screens";

// --------------------------------------------------------------------------
// Which widget a thing shows
// --------------------------------------------------------------------------

/** A widget's face: the page each kind draws. */
export type FaceId =
  | "status"
  | "feed"
  | "needs"
  | "tasks"
  | "my-tasks"
  | "calendar"
  | "photos"
  | "ticker"
  | "chart"
  | "agenda"
  | "dashboard"
  | "kiosk"
  | "whiteboard";

/** The face each kind of thing has of its own. */
export const KIND_FACE: Record<string, FaceId> = {
  status_board: "status",
  feed: "feed",
  needs_board: "needs",
  board: "tasks",
  todo: "my-tasks",
  calendar: "calendar",
  photo_wall: "photos",
  ticker: "ticker",
  chart: "chart",
  agenda: "agenda",
  screen: "dashboard",
  kiosk: "kiosk",
  display: "status",
  monitor: "agenda",
  whiteboard: "whiteboard",
};

/**
 * Each face's size in metres, as the thing made for it is built: its page is
 * laid out at this size (`SURFACE_PX` a metre), and on anything else (a
 * display stand, a desk monitor) it is zoomed to fit the height it has.
 */
export const FACE_SIZE: Record<FaceId, [number, number]> = {
  status: [1.42, 0.92],
  feed: [0.87, 1.22],
  needs: [1.12, 0.77],
  tasks: [1.32, 0.82],
  "my-tasks": [0.56, 0.78],
  calendar: [0.94, 0.9],
  photos: [1.62, 0.97],
  ticker: [1.74, 0.36],
  chart: [1.12, 0.72],
  agenda: [0.74, 0.74],
  dashboard: [1.52, 0.84],
  kiosk: [0.56, 0.38],
  whiteboard: [1.44, 0.94],
};

/** Kinds that show whichever widget `shows` names. */
const ANY_FACE = new Set(["display", "monitor"]);

/** What people and agents call each face, for a display stand's `shows`. */
const FACE_WORDS: Record<string, FaceId> = {
  status: "status",
  "status board": "status",
  agents: "status",
  who: "status",
  "who's doing what": "status",
  feed: "feed",
  activity: "feed",
  "activity feed": "feed",
  needs: "needs",
  "needs you": "needs",
  approvals: "needs",
  inbox: "needs",
  tasks: "tasks",
  board: "tasks",
  "task board": "tasks",
  kanban: "tasks",
  "my tasks": "my-tasks",
  todo: "my-tasks",
  "to do": "my-tasks",
  "to-do": "my-tasks",
  "to-do list": "my-tasks",
  calendar: "calendar",
  photos: "photos",
  "photo wall": "photos",
  selfies: "photos",
  ticker: "ticker",
  "room ticker": "ticker",
  room: "ticker",
  chart: "chart",
  charts: "chart",
  agenda: "agenda",
  clock: "agenda",
  day: "agenda",
  "my day": "agenda",
  dashboard: "dashboard",
  screen: "dashboard",
};

/** Which widget a thing shows, and what it shows it of: a chart's measure, a ticker's room, a dashboard widget. */
export interface FaceChoice {
  face: FaceId;
  arg?: string;
}

const bare = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, " ");

/**
 * The widget a thing shows, from its kind and its `shows`: a kind with one
 * face of its own shows that, `shows` saying what of (a chart's measure, a
 * ticker's room, the dashboard widget a screen keeps to); a display stand or
 * a desk monitor shows the face `shows` names, then what of after a colon
 * ("chart: tasks"), and a measure or a widget's id alone means a chart of it
 * or that widget. None for a thing with no face.
 */
export function faceOf(prop: { kind: string; shows?: string }): FaceChoice | undefined {
  const own = KIND_FACE[prop.kind];
  if (!own) return undefined;
  const shows = prop.shows?.trim();
  if (!ANY_FACE.has(prop.kind)) return shows ? { face: own, arg: shows } : { face: own };
  if (!shows) return { face: own };
  const [head = "", ...rest] = shows.split(":");
  const arg = rest.join(":").trim();
  const face = FACE_WORDS[bare(head)];
  if (face) return arg ? { face, arg } : { face };
  if (measureOf(head)) return { face: "chart", arg: head.trim() };
  // Anything else is a dashboard widget, by its id or title.
  return { face: "dashboard", arg: shows };
}

// --------------------------------------------------------------------------
// Who is doing what
// --------------------------------------------------------------------------

/** A group on the status board, and the doings it gathers. */
export interface WhoGroupSpec {
  id: "waiting" | "stuck" | "working" | "talking" | "out" | "idle" | "asleep";
  title: string;
  doings: AgentActivity["doing"][];
}

/**
 * The groups, in the board's order: what needs a person first, a turn that
 * failed or stalled straight after. Out is idle and somewhere on its day (see
 * `isOut` in `routines.ts`), so it gathers no doing of its own.
 */
export const WHO_GROUPS: WhoGroupSpec[] = [
  { id: "waiting", title: "Waiting on you", doings: ["waiting"] },
  { id: "stuck", title: "Stuck", doings: ["stuck"] },
  { id: "working", title: "Working", doings: ["working", "thinking"] },
  { id: "talking", title: "Talking", doings: ["talking"] },
  { id: "out", title: "Out and about", doings: [] },
  { id: "idle", title: "Idle", doings: ["idle"] },
  { id: "asleep", title: "Asleep", doings: ["asleep"] },
];

/** One agent on the status board. */
export interface WhoRow {
  agent: string;
  doing: AgentActivity["doing"];
  /** What it is doing, in its status line's words; idle or asleep, what it did last. */
  what: string;
  detail?: string;
  /** How long it has been at it, or since it last did something. */
  when?: string;
}

export interface WhoGroup extends WhoGroupSpec {
  rows: WhoRow[];
}

/**
 * Every agent, in the group for what it is doing, each group in order: those
 * waiting on you longest first, the busy ones longest at it first, the idle
 * by what they did last, newest first, then by name.
 */
export function whoGroups(activities: Record<string, AgentActivity>, agents: string[], now = Date.now()): WhoGroup[] {
  const all = [...new Set([...agents, ...Object.keys(activities)])];
  const groupOf = (a: AgentActivity) =>
    isOut(a) ? "out" : (WHO_GROUPS.find((g) => g.doings.includes(a.doing))?.id ?? "idle");
  const rows = all.map((agent): WhoRow & { at: number; group: WhoGroupSpec["id"] } => {
    const a = activities[agent];
    if (!a) return { agent, doing: "idle", what: "idle", at: Number.NEGATIVE_INFINITY, group: "idle" };
    const group = groupOf(a);
    // Out, what it is doing there says more than what it last did: "having a coffee at the café".
    const quiet = (a.doing === "idle" || a.doing === "asleep") && group !== "out";
    const last = quiet && a.last?.what ? a.last : undefined;
    const at = whenMs(last ? last.at : a.since);
    const when = last ? ago(last.at, now) : lasting(a.since, now);
    return {
      agent,
      doing: a.doing,
      what: last ? pastTense(last.what) : a.doing === "asleep" ? (a.detail ?? "asleep") : a.what,
      ...(a.detail && !quiet ? { detail: a.detail } : {}),
      ...(when ? { when } : {}),
      at: Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY,
      group,
    };
  });
  return WHO_GROUPS.map((g) => {
    const mine = rows.filter((r) => r.group === g.id);
    const quiet = g.id === "idle" || g.id === "asleep";
    mine.sort((a, b) => (quiet ? b.at - a.at : a.at - b.at) || a.agent.localeCompare(b.agent));
    return { ...g, rows: mine.map(({ at: _, group: __, ...r }) => r) };
  });
}

// --------------------------------------------------------------------------
// The activity feed
// --------------------------------------------------------------------------

/** One thing an agent did, as `GET /api/ext/builtin:activity/feed` sends it. */
export interface FeedItem {
  id: string;
  kind: "turn" | "tool" | "post" | "done";
  agent: string;
  text: string;
  detail?: string;
  at: string;
  room?: string;
  task?: string;
  /** The same thing done several times running, as one line: how many. */
  times?: number;
}

export type FeedFilter = "all" | FeedItem["kind"];

export const FEED_FILTERS: { id: FeedFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "turn", label: "Replies" },
  { id: "tool", label: "Tools" },
  { id: "post", label: "Posts" },
  { id: "done", label: "Done" },
];

/** How close together the same tool used again by the same agent is folded into one line. */
const FOLD_MS = 10 * 60_000;

/**
 * The feed as shown: of one kind or all, of some agents or all, newest
 * first, with the same tool used again and again by one agent in a short
 * while folded into one line that says how many times.
 */
export function feedShown(items: FeedItem[], filter: FeedFilter, who?: string[]): FeedItem[] {
  const out: FeedItem[] = [];
  for (const item of items) {
    if (filter !== "all" && item.kind !== filter) continue;
    if (who && !who.includes(item.agent)) continue;
    const last = out.at(-1);
    if (
      last &&
      item.kind === "tool" &&
      last.kind === "tool" &&
      last.agent === item.agent &&
      last.text === item.text &&
      whenMs(last.at) - whenMs(item.at) < FOLD_MS
    ) {
      out[out.length - 1] = { ...last, times: (last.times ?? 1) + 1 };
      continue;
    }
    out.push(item);
  }
  return out;
}

/** What a line of the feed says after the agent's name: "replied", "searching the web ×3", "finished". */
export function feedVerb(item: FeedItem): string {
  switch (item.kind) {
    case "turn":
      return "replied";
    case "post":
      return item.room ? "posted" : "messaged";
    case "done":
      return "finished";
    default:
      return item.times && item.times > 1 ? `${item.text} ×${item.times}` : item.text;
  }
}

// --------------------------------------------------------------------------
// The task board: filters and load
// --------------------------------------------------------------------------

/** A task as the board's filters need it. */
export interface FilterTask extends BoardTask {
  project_id?: string | null;
}

/** Who and which project a board is narrowed to; none of either, everything. */
export interface BoardFilter {
  who?: string;
  project?: string;
}

/** The tasks a board shows, narrowed to an assignee or a project. */
export function boardFiltered<T extends FilterTask>(tasks: T[], filter: BoardFilter): T[] {
  return tasks.filter(
    (t) => (!filter.who || t.assignee === filter.who) && (!filter.project || t.project_id === filter.project),
  );
}

/** Tasks in progress one agent can carry before the board says it has too many. */
export const WIP_EACH = 3;

/** One assignee as a board's filter offers them: how many open tasks, how many in progress, and whether too many. */
export interface Assignee {
  agent: string;
  open: number;
  doing: number;
  over: boolean;
}

const DOING = GROUPS.find((g) => g.id === "doing")?.statuses ?? [];
const DONE = GROUPS.find((g) => g.id === "done")?.statuses ?? [];

/** Everyone with a task on the board, most open tasks first: what the board's filter offers. */
export function assigneesOf(tasks: BoardTask[], each = WIP_EACH): Assignee[] {
  const by = new Map<string, Assignee>();
  for (const t of tasks) {
    if (!t.assignee) continue;
    const a = by.get(t.assignee) ?? { agent: t.assignee, open: 0, doing: 0, over: false };
    if (!DONE.includes(t.status)) a.open++;
    if (DOING.includes(t.status)) a.doing++;
    a.over = a.doing > each;
    by.set(t.assignee, a);
  }
  return [...by.values()].sort((a, b) => b.open - a.open || a.agent.localeCompare(b.agent));
}

/** The projects tasks on the board belong to, by id, most tasks first. */
export function projectsOf(tasks: FilterTask[]): { id: string; n: number }[] {
  const by = new Map<string, number>();
  for (const t of tasks) if (t.project_id) by.set(t.project_id, (by.get(t.project_id) ?? 0) + 1);
  return [...by.entries()].map(([id, n]) => ({ id, n })).sort((a, b) => b.n - a.n || a.id.localeCompare(b.id));
}

/** One agent's open tasks for a to-do list: what is in hand first, then blocked, then waiting to start; newest first within each. */
export function todoFor(tasks: BoardTask[], who: string[] | undefined): BoardTask[] {
  const rank = (s: string) => (DOING.includes(s) ? 0 : s === "blocked" ? 1 : 2);
  return tasks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => !DONE.includes(t.status) && t.status !== "archived" && (!who || who.includes(t.assignee ?? "")))
    .sort((a, b) => rank(a.t.status) - rank(b.t.status) || a.i - b.i)
    .map(({ t }) => t);
}

// --------------------------------------------------------------------------
// The photo wall
// --------------------------------------------------------------------------

/** A photo kept on a place, as `GET /api/ext/builtin:places/photos` sends it. */
export interface WallPhoto {
  media: string;
  what: string;
  at: string;
  place: string;
  placeName: string;
  by?: string;
}

/** How long each photo is the big one on a photo wall. */
export const SLIDE_MS = 9_000;

/** Which photo is the big one at `now`: read off the clock, like a screen's page, so every wall agrees. */
export function slideAt(now: number, count: number, every = SLIDE_MS): number {
  return count > 1 ? Math.floor(now / every) % count : 0;
}

/** Where a photo is fetched from. */
export function photoUrl(media: string): string {
  return `/api/media/${encodeURIComponent(media)}`;
}

/** A photo's caption: who took it, of what, and when. */
export function photoCaption(p: WallPhoto, now = Date.now()): string {
  const of = p.what === "a selfie" ? (p.by ? "a selfie" : `a selfie in ${p.placeName}`) : `in ${p.placeName}`;
  const when = ago(p.at, now);
  return [p.by ? `${nameOf(p.by)}, ${of}` : of, when].filter(Boolean).join(" · ");
}

// --------------------------------------------------------------------------
// The room ticker
// --------------------------------------------------------------------------

/** A line on a ticker: who said it, what, when, and in which room. */
export interface TickerLine {
  id: string;
  who: string;
  /** The agent behind the name, when it is one: what the line is coloured by. */
  agent?: string;
  text: string;
  at: string;
  /** On a ticker of every room, the room it was said in, by name. */
  room?: string;
}

/** Lines a ticker keeps. */
export const TICKER_LINES = 12;

/**
 * The latest lines said in rooms, from what each agent last said (its
 * `speech` record): newest first, only what was said in a room, never a
 * direct message, and in one room only when `room` is given.
 */
export function tickerFromSpeech(
  said: Record<string, { text: string; at: string; room?: string }>,
  room?: string,
  limit = TICKER_LINES,
): TickerLine[] {
  return Object.entries(said)
    .filter(([, s]) => !!s.room && (!room || s.room === room) && !!s.text)
    .map(([agent, s]) => ({ id: `${agent}:${s.at}`, who: nameOf(agent), agent, text: s.text, at: s.at }))
    .sort((a, b) => whenMs(b.at) - whenMs(a.at))
    .slice(0, limit);
}

/**
 * A room's latest lines, as a meeting room's transcript has them, newest
 * first; or every room's, as the server gathers them, each with the name of
 * the room it was said in.
 */
export function tickerFromTranscript(
  lines: { id: string; who: string; agent?: string; text: string; at: string; roomName?: string }[],
  limit = TICKER_LINES,
): TickerLine[] {
  // Lines said in the same second keep the transcript's order, oldest first, so the later one still comes first here.
  return lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => !!l.text?.trim())
    .sort((a, b) => whenMs(b.l.at) - whenMs(a.l.at) || b.i - a.i)
    .slice(0, limit)
    .map(({ l }) => ({
      id: l.roomName ? `${l.roomName}:${l.id}` : l.id,
      who: l.who,
      ...(l.agent ? { agent: l.agent } : {}),
      text: l.text,
      at: l.at,
      ...(l.roomName ? { room: l.roomName } : {}),
    }));
}

// --------------------------------------------------------------------------
// The clock and the day's agenda
// --------------------------------------------------------------------------

/** One line of the day's agenda: something coming, or something done. */
export interface AgendaItem {
  key: string;
  at: number;
  agent: string;
  what: string;
  /** Already done today, or still to come. */
  done?: boolean;
  kind?: Wake["kind"];
}

/** Lines of what is coming the agenda shows, and of what was done. */
const AGENDA_COMING = 8;
const AGENDA_DONE = 4;

/**
 * The day's agenda: what is still to come today, soonest first (and, late in
 * the day with nothing left, the first of tomorrow's), then what got done
 * today, newest first.
 */
export function agendaFor(wakes: Wake[], done: Done[], now: number): { coming: AgendaItem[]; done: AgendaItem[] } {
  const end = new Date(now);
  end.setHours(24, 0, 0, 0);
  const today = wakes.filter((w) => w.at < end.getTime());
  const soon = today.length ? today : wakes.slice(0, 3);
  return {
    coming: soon
      .slice(0, AGENDA_COMING)
      .map((w) => ({ key: w.key, at: w.at, agent: w.agent, what: w.what, kind: w.kind })),
    done: done.slice(0, AGENDA_DONE).map((d) => ({ key: d.key, at: d.at, agent: d.agent, what: d.what, done: true })),
  };
}

// --------------------------------------------------------------------------
// From across a room
// --------------------------------------------------------------------------

const DOING_TONE: Partial<Record<AgentActivity["doing"], Tone>> = {
  working: "ok",
  thinking: "info",
  talking: "info",
  waiting: "warn",
  stuck: "bad",
};

/** The status board from across a room: how many are working, and who waits on you. */
export function statusGlance(groups: WhoGroup[]): ScreenCard {
  const count = (id: WhoGroup["id"]) => groups.find((g) => g.id === id)?.rows.length ?? 0;
  const busy = count("working") + count("talking");
  const waiting = groups.find((g) => g.id === "waiting")?.rows ?? [];
  const stuck = groups.find((g) => g.id === "stuck")?.rows ?? [];
  const first = [
    ...waiting.map((r) => ({ text: nameOf(r.agent), meta: r.what, tag: { text: "you", tone: "warn" as Tone } })),
    ...stuck.map((r) => ({ text: nameOf(r.agent), meta: r.what, tag: { text: "stuck", tone: "bad" as Tone } })),
  ].slice(0, 2);
  const rows: ScreenRow[] = [
    ...first,
    ...groups
      .filter((g) => g.id === "working" || g.id === "talking")
      .flatMap((g) => g.rows)
      .slice(0, 3 - first.length)
      .map((r) => ({
        text: nameOf(r.agent),
        meta: r.what,
        tag: { text: r.doing, tone: DOING_TONE[r.doing] ?? "dim" },
      })),
  ];
  return {
    id: "status",
    title: "Who's doing what",
    big: {
      text: busy ? `${busy} busy` : count("out") ? `${count("out")} out` : "All quiet",
      sub: `${busy && count("out") ? `${count("out")} out · ` : ""}${count("idle")} idle · ${count("asleep")} asleep${waiting.length ? ` · ${waiting.length} waiting on you` : ""}${stuck.length ? ` · ${stuck.length} stuck` : ""}`,
      tone: stuck.length ? "bad" : waiting.length ? "warn" : busy ? "ok" : "dim",
    },
    rows,
  };
}

/** The feed from across a room: its newest lines. */
export function feedGlance(items: FeedItem[] | undefined, now = Date.now()): ScreenCard {
  const card: ScreenCard = { id: "feed", title: "Activity" };
  if (!items) return { ...card, empty: "Loading…" };
  if (!items.length) return { ...card, empty: "Nothing done in the last two days" };
  return {
    ...card,
    rows: feedShown(items, "all")
      .slice(0, 5)
      .map((i) => ({ text: `${nameOf(i.agent)} ${feedVerb(i)}`, ...(ago(i.at, now) ? { meta: ago(i.at, now) } : {}) })),
  };
}

/** The needs-you board from across a room: how many are waiting, and on what. */
export function needsGlance(needs: { agent: string; what: string }[]): ScreenCard {
  if (!needs.length)
    return { id: "needs", title: "Needs you", big: { text: "Nothing", sub: "No one is waiting on you", tone: "ok" } };
  return {
    id: "needs",
    title: "Needs you",
    big: { text: `${needs.length} waiting`, tone: "warn" },
    rows: needs.slice(0, 3).map((n) => ({ text: nameOf(n.agent), meta: n.what })),
  };
}

/** A to-do list from across a room. */
export function todoGlance(tasks: BoardTask[], title: string): ScreenCard {
  if (!tasks.length) return { id: "my-tasks", title, empty: "Nothing to do" };
  return {
    id: "my-tasks",
    title,
    big: { text: `${tasks.length} open` },
    rows: tasks.slice(0, 4).map((t) => ({ text: t.title })),
  };
}

/** The photo wall from across a room, until a photo can be shown. */
export function photosGlance(photos: WallPhoto[] | undefined): ScreenCard {
  if (!photos?.length) return { id: "photos", title: "Photos", empty: "No photos yet" };
  return {
    id: "photos",
    title: "Photos",
    big: { text: `${photos.length}`, sub: photos.length === 1 ? "photo" : "photos" },
  };
}

/** A ticker from across a room: its newest line. */
export function tickerGlance(lines: TickerLine[], title: string): ScreenCard {
  const first = lines[0];
  if (!first) return { id: "ticker", title, empty: "Quiet so far" };
  return {
    id: "ticker",
    title,
    rows: lines.slice(0, 2).map((l) => ({ text: l.text, meta: l.room ? `${l.who} · #${l.room}` : l.who })),
  };
}

/** The clock from across a room: the time, and what comes next. */
export function agendaGlance(next: AgendaItem | undefined): ScreenCard {
  return {
    id: "agenda",
    title: new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }),
    clock: true,
    ...(next ? { lines: [`Next: ${clockTime(next.at)} ${nameOf(next.agent)}, ${next.what}`] } : {}),
  };
}

// --------------------------------------------------------------------------
// What the page gives the widgets
// --------------------------------------------------------------------------

/** Something fetched for the widgets: what came, and why nothing newer did, the last time it was asked for. */
export interface Loaded<T> {
  data?: T;
  error?: string;
}

/** A ticker's lines and what it is called: the room's name, or "Every room". */
export interface TickerData {
  title: string;
  lines: TickerLine[];
  error?: string;
  /** The meeting room it hangs in is the room it shows: its name says nothing the room doesn't. */
  here?: boolean;
}

/** Everything the widgets in a place show, from the page: one fetch of each for every widget in view. */
export interface WorldData {
  /** What every agent is doing, talks and all. */
  activities: Record<string, AgentActivity>;
  /** Every agent there is, for the status board's idle and asleep. */
  agents: string[];
  /** What agents wait on you for, approvals with what the server says of them. */
  needs: Need[];
  feed: Loaded<FeedItem[]>;
  stats: Loaded<StatsData>;
  photos: Loaded<WallPhoto[]>;
  /** A ticker's lines: of the room named, or of the place's own room, or of every room. */
  ticker: (room?: string) => TickerData;
  /** The wakes to come, soonest first, and what got done today: for the clock's agenda. */
  wakes: Wake[];
  done: Done[];
  /** Whose things the widgets here show: a home's owner, or whoever is in the place; none, everyone's. */
  whose?: string[];
  /** The home's owner, when the place is a home: "planner's to-do". */
  owner?: string;
  /** Every task on the boards, newest first, for to-do lists. */
  tasks: (BoardTask & { project_id?: string | null })[];
  /** Projects by id: their names, for a board's filter. */
  projects: Record<string, string>;
  now: number;
}

/**
 * What a chart shows: the measure it was given, or, going through all four,
 * the one the clock says, a minute each. The page's clock for the widgets
 * moves on by the minute, so a chart and the picture drawn of it turn over
 * together.
 */
export function chartMeasure(arg: string | undefined, now: number, every = 60_000): Measure {
  return measureOf(arg) ?? (MEASURES[Math.floor(now / every) % MEASURES.length]?.id as Measure);
}

/** A to-do list's title: whose it is. */
export function todoTitle(world: Pick<WorldData, "owner" | "whose">): string {
  if (world.owner) return `${nameOf(world.owner)}'s to-do`;
  return world.whose ? "To do here" : "Everyone's to-do";
}

/**
 * The picture a widget draws of itself from across a room, or in a photo:
 * the few things worth reading from there. None for a face drawn some other
 * way (a board, a calendar, a screen, a kiosk).
 */
export function glanceFor(choice: FaceChoice, world: WorldData): ScreenCard | undefined {
  const who = world.whose;
  switch (choice.face) {
    case "status":
      return statusGlance(whoGroups(world.activities, world.agents, world.now));
    case "feed":
      return feedGlance(
        world.feed.data && (who ? world.feed.data.filter((i) => who.includes(i.agent)) : world.feed.data),
        world.now,
      );
    case "needs":
      return needsGlance(world.needs);
    case "my-tasks":
      return todoGlance(todoFor(world.tasks, who), todoTitle(world));
    case "photos":
      return photosGlance(world.photos.data);
    case "ticker": {
      const t = world.ticker(choice.arg);
      // In the meeting room it shows, no name: the room's line has the whole strip.
      return tickerGlance(t.lines, t.here ? "" : t.title);
    }
    case "chart":
      return chartGlance(world.stats.data, chartMeasure(choice.arg, world.now), world.now, who);
    case "agenda": {
      const day = agendaFor(
        world.wakes.filter((w) => !who || who.includes(w.agent)),
        [],
        world.now,
      );
      return agendaGlance(day.coming[0]);
    }
    default:
      return undefined;
  }
}
