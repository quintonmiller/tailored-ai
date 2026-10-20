/**
 * The widgets on the walls, worked out without a page: which widget a thing
 * shows, who is doing what, the feed and its filters, a board's filters and
 * load, a to-do list, a photo wall's slideshow, a ticker's lines, the day's
 * agenda, and what each shows from across a room.
 */
import { describe, expect, it } from "vitest";
import type { Need } from "../lib/needs";
import type { Wake } from "./calendar";
import type { StatsData } from "./charts";
import type { AgentActivity } from "./doing";
import {
  agendaFor,
  assigneesOf,
  boardFiltered,
  chartMeasure,
  type FeedItem,
  faceOf,
  feedGlance,
  feedShown,
  feedVerb,
  glanceFor,
  needsGlance,
  photoCaption,
  projectsOf,
  slideAt,
  statusGlance,
  tickerFromSpeech,
  tickerFromTranscript,
  todoFor,
  todoTitle,
  type WorldData,
  whoGroups,
} from "./widgets";

const NOW = Date.parse("2026-10-20T15:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

describe("which widget a thing shows", () => {
  it("is its kind's own, with what `shows` says it is of", () => {
    expect(faceOf({ kind: "status_board" })).toEqual({ face: "status" });
    expect(faceOf({ kind: "chart", shows: "tokens" })).toEqual({ face: "chart", arg: "tokens" });
    expect(faceOf({ kind: "ticker", shows: "#lisbon-trip" })).toEqual({ face: "ticker", arg: "#lisbon-trip" });
    expect(faceOf({ kind: "screen", shows: "in-review" })).toEqual({ face: "dashboard", arg: "in-review" });
    expect(faceOf({ kind: "board" })).toEqual({ face: "tasks" });
    expect(faceOf({ kind: "couch" })).toBeUndefined();
  });

  it("on a display stand or a monitor, is whatever `shows` names, then what of after a colon", () => {
    expect(faceOf({ kind: "display" })).toEqual({ face: "status" });
    expect(faceOf({ kind: "monitor" })).toEqual({ face: "agenda" });
    expect(faceOf({ kind: "display", shows: "Feed" })).toEqual({ face: "feed" });
    expect(faceOf({ kind: "display", shows: "my tasks" })).toEqual({ face: "my-tasks" });
    expect(faceOf({ kind: "display", shows: "chart: tasks" })).toEqual({ face: "chart", arg: "tasks" });
    expect(faceOf({ kind: "monitor", shows: "ticker: lisbon-trip" })).toEqual({ face: "ticker", arg: "lisbon-trip" });
  });

  it("takes a measure alone for a chart of it, and anything else for one of the Board's widgets", () => {
    expect(faceOf({ kind: "display", shows: "tokens" })).toEqual({ face: "chart", arg: "tokens" });
    expect(faceOf({ kind: "display", shows: "in-review" })).toEqual({ face: "dashboard", arg: "in-review" });
  });
});

describe("who is doing what", () => {
  const activities: Record<string, AgentActivity> = {
    planner: { agent: "planner", doing: "working", what: "searching the web", detail: "hotels", since: ago(12) },
    writer: { agent: "writer", doing: "thinking", what: "thinking", since: ago(2) },
    reviewer: { agent: "reviewer", doing: "waiting", what: "has a question for you", since: ago(30) },
    tester: { agent: "tester", doing: "waiting", what: "waiting for your OK", since: ago(5) },
    coder: { agent: "coder", doing: "stuck", what: "ran out of steps", since: ago(40) },
    mailer: { agent: "mailer", doing: "idle", what: "idle", last: { what: "sending a mail", at: ago(90) } },
    sorter: { agent: "sorter", doing: "idle", what: "idle", last: { what: "sorting notes", at: ago(10) } },
    sleeper: { agent: "sleeper", doing: "asleep", what: "asleep", detail: "paused" },
  };

  it("puts every agent in the group for what it is doing, in the order the board shows them", () => {
    const groups = whoGroups(activities, ["newcomer"], NOW);
    expect(groups.map((g) => g.id)).toEqual(["waiting", "working", "talking", "idle", "asleep"]);
    const of = (id: string) => groups.find((g) => g.id === id)?.rows.map((r) => r.agent);
    // Waiting longest first; busy longest at it first, stuck counted as at work.
    expect(of("waiting")).toEqual(["reviewer", "tester"]);
    expect(of("working")).toEqual(["coder", "planner", "writer"]);
    expect(of("talking")).toEqual([]);
    // Idle by what it did last, newest first; one never heard from last.
    expect(of("idle")).toEqual(["sorter", "mailer", "newcomer"]);
    expect(of("asleep")).toEqual(["sleeper"]);
  });

  it("says what each is at and for how long, and what an idle one did last", () => {
    const groups = whoGroups(activities, [], NOW);
    const row = (agent: string) => groups.flatMap((g) => g.rows).find((r) => r.agent === agent);
    expect(row("planner")).toMatchObject({ what: "searching the web", detail: "hotels", when: "12 min" });
    expect(row("sorter")).toMatchObject({ what: "sorted notes", when: "10 min ago" });
    expect(row("sleeper")).toMatchObject({ what: "paused" });
  });

  it("from across a room: how many are busy, and who waits on you", () => {
    const card = statusGlance(whoGroups(activities, [], NOW));
    expect(card.big).toMatchObject({ text: "3 busy", tone: "warn" });
    expect(card.big?.sub).toContain("2 waiting on you");
    expect(card.rows?.[0]).toMatchObject({ text: "reviewer", tag: { text: "you" } });
    expect(statusGlance(whoGroups({}, ["a"], NOW)).big).toMatchObject({ text: "All quiet", tone: "dim" });
  });
});

describe("the feed", () => {
  const items: FeedItem[] = [
    { id: "4", kind: "tool", agent: "planner", text: "searching the web", detail: "ferries", at: ago(1) },
    { id: "3", kind: "tool", agent: "planner", text: "searching the web", at: ago(3) },
    { id: "2", kind: "tool", agent: "planner", text: "searching the web", at: ago(5) },
    { id: "1", kind: "turn", agent: "writer", text: "Draft is ready.", at: ago(6) },
    { id: "0", kind: "tool", agent: "planner", text: "searching the web", at: ago(30) },
    { id: "t", kind: "done", agent: "writer", text: "Draft the plan", at: ago(40), task: "t-1" },
  ];

  it("folds the same tool used again and again by one agent into one line, saying how many times", () => {
    const shown = feedShown(items, "all");
    expect(shown.map((i) => i.id)).toEqual(["4", "1", "0", "t"]);
    expect(shown[0]?.times).toBe(3);
    expect(feedVerb(shown[0] as FeedItem)).toBe("searching the web ×3");
    // Not across something else in between, nor long after.
    expect(shown[2]?.times).toBeUndefined();
    const apart: FeedItem[] = [
      { id: "b", kind: "tool", agent: "planner", text: "searching the web", at: ago(1) },
      { id: "a", kind: "tool", agent: "planner", text: "searching the web", at: ago(60) },
    ];
    expect(feedShown(apart, "all").map((i) => i.id)).toEqual(["b", "a"]);
  });

  it("narrows to one kind, and to some agents", () => {
    expect(feedShown(items, "done").map((i) => i.id)).toEqual(["t"]);
    expect(feedShown(items, "all", ["writer"]).map((i) => i.id)).toEqual(["1", "t"]);
  });

  it("says what each line is after the agent's name", () => {
    expect(feedVerb({ ...items[3], kind: "turn" } as FeedItem)).toBe("replied");
    expect(feedVerb({ ...items[3], kind: "post", room: "local:trip" } as FeedItem)).toBe("posted");
    expect(feedVerb({ ...items[3], kind: "post" } as FeedItem)).toBe("messaged");
    expect(feedVerb(items[5] as FeedItem)).toBe("finished");
  });

  it("from across a room: its newest lines, or why there are none", () => {
    expect(feedGlance(undefined).empty).toBe("Loading…");
    expect(feedGlance([]).empty).toBe("Nothing done in the last two days");
    expect(feedGlance(items, NOW).rows?.[0]).toEqual({ text: "planner searching the web ×3", meta: "1 min ago" });
  });
});

describe("the task board's filters and load", () => {
  const tasks = [
    { id: "1", title: "A", status: "in_progress", assignee: "planner", project_id: "p1" },
    { id: "2", title: "B", status: "in_review", assignee: "planner", project_id: "p1" },
    { id: "3", title: "C", status: "in_progress", assignee: "planner", project_id: "p2" },
    { id: "4", title: "D", status: "in_progress", assignee: "planner" },
    { id: "5", title: "E", status: "backlog", assignee: "writer", project_id: "p2" },
    { id: "6", title: "F", status: "done", assignee: "writer", project_id: "p2" },
    { id: "7", title: "G", status: "blocked" },
  ];

  it("narrows the board to one agent's tasks, one project's, or both", () => {
    expect(boardFiltered(tasks, { who: "writer" }).map((t) => t.id)).toEqual(["5", "6"]);
    expect(boardFiltered(tasks, { project: "p1" }).map((t) => t.id)).toEqual(["1", "2"]);
    expect(boardFiltered(tasks, { who: "planner", project: "p2" }).map((t) => t.id)).toEqual(["3"]);
    expect(boardFiltered(tasks, {})).toHaveLength(7);
  });

  it("offers everyone with a task, most open first, saying who has too much in progress", () => {
    expect(assigneesOf(tasks)).toEqual([
      { agent: "planner", open: 4, doing: 4, over: true },
      { agent: "writer", open: 1, doing: 0, over: false },
    ]);
    expect(assigneesOf(tasks, 4)[0]?.over).toBe(false);
  });

  it("offers the projects tasks belong to, most tasks first", () => {
    expect(projectsOf(tasks)).toEqual([
      { id: "p2", n: 3 },
      { id: "p1", n: 2 },
    ]);
  });

  it("lists an agent's open tasks for a to-do list: in hand first, then blocked, then waiting to start", () => {
    const mine = [
      { id: "a", title: "later", status: "backlog", assignee: "planner" },
      { id: "b", title: "stuck", status: "blocked", assignee: "planner" },
      { id: "c", title: "now", status: "in_progress", assignee: "planner" },
      { id: "d", title: "done", status: "done", assignee: "planner" },
      { id: "e", title: "theirs", status: "in_progress", assignee: "writer" },
    ];
    expect(todoFor(mine, ["planner"]).map((t) => t.id)).toEqual(["c", "b", "a"]);
    expect(todoFor(mine, undefined).map((t) => t.id)).toEqual(["c", "e", "b", "a"]);
    expect(todoTitle({ owner: "planner" })).toBe("planner's to-do");
    expect(todoTitle({ whose: ["a"] })).toBe("To do here");
    expect(todoTitle({})).toBe("Everyone's to-do");
  });
});

describe("the photo wall", () => {
  it("turns over by the clock, the same photo on every wall", () => {
    expect(slideAt(0, 4)).toBe(0);
    expect(slideAt(9_000, 4)).toBe(1);
    expect(slideAt(9_000 * 5, 4)).toBe(1);
    expect(slideAt(123_456, 1)).toBe(0);
  });

  it("captions a photo with who took it, of what, and when", () => {
    const at = ago(120);
    expect(
      photoCaption({ media: "m", what: "a selfie", at, place: "home:planner", placeName: "x", by: "planner" }, NOW),
    ).toBe("planner, a selfie · 2 h ago");
    expect(
      photoCaption({ media: "m", what: "the lounge", at, place: "shared:lounge", placeName: "the lounge" }, NOW),
    ).toBe("in the lounge · 2 h ago");
    expect(
      photoCaption({ media: "m", what: "a selfie", at, place: "shared:lounge", placeName: "the lounge" }, NOW),
    ).toBe("a selfie in the lounge · 2 h ago");
  });
});

describe("a room ticker", () => {
  const said = {
    planner: { text: "Booked the ferry.", at: ago(2), room: "local:trip" },
    writer: { text: "Draft is up.", at: ago(1), room: "local:review" },
    reviewer: { text: "between us", at: ago(0) },
  };

  it("takes the latest lines said in rooms, newest first, never a direct message", () => {
    expect(tickerFromSpeech(said).map((l) => l.agent)).toEqual(["writer", "planner"]);
    expect(tickerFromSpeech(said, "local:trip").map((l) => l.text)).toEqual(["Booked the ferry."]);
  });

  it("takes a room's transcript newest first, leaving out empty lines", () => {
    const lines = tickerFromTranscript([
      { id: "1", who: "sam", text: "Morning", at: ago(9) },
      { id: "2", who: "planner", agent: "planner", text: "  ", at: ago(5) },
      { id: "3", who: "planner", agent: "planner", text: "On it", at: ago(4) },
    ]);
    expect(lines.map((l) => l.id)).toEqual(["3", "1"]);
    expect(lines[1]).not.toHaveProperty("agent");
  });
});

describe("the day's agenda", () => {
  const wake = (key: string, at: number, agent = "planner"): Wake => ({ key, agent, at, kind: "booked", what: key });

  it("lists what is still to come today, then what got done", () => {
    const now = new Date(2026, 9, 20, 9, 0).getTime();
    const day = agendaFor(
      [wake("soon", now + 3_600_000), wake("tonight", now + 10 * 3_600_000), wake("tomorrow", now + 26 * 3_600_000)],
      [{ key: "d", agent: "writer", at: now - 60_000, what: "finished “Plan”" }],
      now,
    );
    expect(day.coming.map((i) => i.key)).toEqual(["soon", "tonight"]);
    expect(day.done[0]).toMatchObject({ key: "d", done: true });
  });

  it("late in the day with nothing left, gives the first of tomorrow's", () => {
    const now = new Date(2026, 9, 20, 23, 0).getTime();
    const day = agendaFor([wake("tomorrow", now + 10 * 3_600_000)], [], now);
    expect(day.coming.map((i) => i.key)).toEqual(["tomorrow"]);
  });
});

describe("what a widget shows from across a room", () => {
  const stats: StatsData = { days: 14, tokens: [], turns: [], done: [], time: [], since: ago(600) };
  const world = (over: Partial<WorldData> = {}): WorldData => ({
    activities: {},
    agents: ["planner"],
    needs: [],
    feed: {},
    stats: { data: stats },
    photos: {},
    ticker: () => ({
      title: "#trip",
      lines: [{ id: "1", who: "planner", agent: "planner", text: "Booked.", at: ago(1) }],
    }),
    wakes: [],
    done: [],
    tasks: [],
    projects: {},
    now: NOW,
    ...over,
  });

  it("is drawn for every widget but those that draw themselves", () => {
    expect(glanceFor({ face: "status" }, world())?.title).toBe("Who's doing what");
    expect(glanceFor({ face: "ticker" }, world())?.rows?.[0]).toEqual({ text: "Booked.", meta: "planner" });
    expect(glanceFor({ face: "chart", arg: "tasks" }, world())?.title).toBe("Tasks done per day");
    expect(glanceFor({ face: "tasks" }, world())).toBeUndefined();
    expect(glanceFor({ face: "dashboard" }, world())).toBeUndefined();
  });

  it("narrows to whose place it is", () => {
    const feed: FeedItem[] = [
      { id: "1", kind: "turn", agent: "writer", text: "x", at: ago(1) },
      { id: "2", kind: "turn", agent: "planner", text: "y", at: ago(2) },
    ];
    const card = glanceFor({ face: "feed" }, world({ feed: { data: feed }, whose: ["planner"] }));
    expect(card?.rows?.map((r) => r.text)).toEqual(["planner replied"]);
  });

  it("says how many wait on you, or that nobody does", () => {
    const need = { key: "k", agent: "reviewer", kind: "question", what: "has a question for you" } as Need;
    expect(needsGlance([need]).big?.text).toBe("1 waiting");
    expect(needsGlance([]).big).toMatchObject({ text: "Nothing", tone: "ok" });
  });

  it("goes through a chart's four measures by the clock unless it was given one", () => {
    expect(chartMeasure("time", 0)).toBe("time");
    expect(chartMeasure(undefined, 0)).toBe("tokens");
    expect(chartMeasure(undefined, 15_000)).toBe("turns");
    expect(chartMeasure(undefined, 60_000)).toBe("tokens");
  });
});
