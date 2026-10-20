/**
 * A calendar on a wall: when agents next wake, from the wakes they booked,
 * the cron jobs that run as them and the turns of agents that run on their
 * own, soonest first and day by day; what they got done today; and which of
 * it fits on the page.
 */
import { describe, expect, it } from "vitest";
import {
  type Booked,
  byDay,
  type CalendarView,
  type CronJob,
  calendarDays,
  calendarLines,
  dayStart,
  doneBetween,
  doneToday,
  type OwnAgent,
  onDay,
  upcoming,
  type Wake,
} from "./calendar";
import type { AgentActivity } from "./doing";

// Mid-morning, on the page's own clock.
const now = new Date(2026, 9, 19, 10, 0).getTime();
const at = (days: number, hour: number, minute = 0) => new Date(2026, 9, 19 + days, hour, minute).getTime();
const iso = (ms: number) => new Date(ms).toISOString();

const booked = (id: string, agent: string, when: number, over: Partial<Booked> = {}): Booked => ({
  id,
  agent,
  note: `note ${id}`,
  kind: "once",
  every: null,
  next_run_at: iso(when),
  target_kind: "session",
  target: "s1",
  ...over,
});

const job = (name: string, agent: string | null, when: number | null, over: Partial<CronJob> = {}): CronJob => ({
  name,
  agent,
  task: `do ${name}`,
  schedule: "0 9 * * *",
  enabled: 1,
  next_run: when === null ? null : iso(when),
  ...over,
});

const own = (name: string, last: number, minutes: number): OwnAgent => ({
  name,
  enabled_in_state: true,
  paused_until: null,
  last_tick_at: iso(last),
  current_interval_ms: null,
  cadence: { interval_minutes: minutes },
});

describe("upcoming", () => {
  const from = {
    booked: [
      booked("b1", "planner", at(0, 14, 30), { note: "check the deploy\nand say how it went" }),
      booked("b2", "writer", at(1, 9), {
        kind: "repeat",
        every: "weekdays at 9am",
        target_kind: "room",
        target: "local:trip",
      }),
    ],
    cron: [job("morning-digest", null, at(1, 8)), job("weekly-review", "reviewer", at(0, 11))],
    cronOn: true,
    own: [own("scout", at(0, 9, 50), 30)],
    ownOn: true,
  };

  it("puts every kind of wake in one list, soonest first", () => {
    const wakes = upcoming(from, now);
    expect(wakes.map((w) => [w.kind, w.agent, w.at])).toEqual([
      ["turn", "scout", at(0, 10, 20)],
      ["cron", "reviewer", at(0, 11)],
      ["booked", "planner", at(0, 14, 30)],
      ["cron", "default", at(1, 8)],
      ["booked", "writer", at(1, 9)],
    ]);
  });

  it("says what each will do, and where and how often it comes", () => {
    const wakes = upcoming(from, now);
    const by = (key: string) => wakes.find((w) => w.key === key) as Wake;
    expect(by("booked:b1")).toMatchObject({
      what: "check the deploy",
      detail: "check the deploy\nand say how it went",
    });
    expect(by("booked:b1").room).toBeUndefined();
    expect(by("booked:b2")).toMatchObject({ every: "weekdays at 9am", room: "local:trip" });
    expect(by("cron:morning-digest")).toMatchObject({
      what: "morning digest",
      detail: "do morning-digest",
      every: "0 9 * * *",
    });
    expect(by("turn:scout")).toMatchObject({ what: "its own turn", every: "every 30 min" });
  });

  it("leaves out cron while cron is off, and own turns while nothing runs them", () => {
    const wakes = upcoming({ ...from, cronOn: false, ownOn: false }, now);
    expect(wakes.map((w) => w.kind)).toEqual(["booked", "booked"]);
  });

  it("leaves out a job switched off, one with no next run, and anything past the week", () => {
    const wakes = upcoming(
      {
        ...from,
        booked: [booked("far", "planner", at(9, 9))],
        cron: [job("off", "planner", at(0, 12), { enabled: 0 }), job("never", "planner", null)],
        own: [],
      },
      now,
    );
    expect(wakes).toEqual([]);
  });

  it("keeps a booked wake that is overdue: it still comes, once agents are going again", () => {
    const wakes = upcoming({ ...from, booked: [booked("late", "planner", at(0, 9))], cron: [], own: [] }, now);
    expect(wakes.map((w) => w.key)).toEqual(["booked:late"]);
  });

  it("puts a turn when the server says the worker takes it: an agent out of its hours is not due every half hour", () => {
    // 22:00, every half hour, its hours 09:00 to 17:00: one turn, at 09:00 tomorrow, not one each half hour tonight.
    const late = new Date(2026, 9, 19, 22, 0).getTime();
    const windowed = {
      ...own("scout", new Date(2026, 9, 19, 16, 50).getTime(), 30),
      cadence: { interval_minutes: 30, window: { start: "09:00", end: "17:00" } },
      next_turn_at: iso(at(1, 9)),
    };
    const wakes = upcoming({ ...from, booked: [], cron: [], own: [windowed] }, late);
    expect(wakes.map((w) => [w.kind, w.at, w.every])).toEqual([["turn", at(1, 9), "every 30 min, 09:00–17:00"]]);
    // None to come, by the server's word (its hours never come): none.
    expect(upcoming({ ...from, booked: [], cron: [], own: [{ ...windowed, next_turn_at: null }] }, late)).toEqual([]);
  });

  it("leaves out an agent that is paused or switched off", () => {
    const paused = { ...own("scout", at(0, 9), 30), paused_until: iso(at(0, 18)) };
    const off = { ...own("other", at(0, 9), 30), enabled_in_state: false };
    expect(upcoming({ ...from, booked: [], cron: [], own: [paused, off] }, now)).toEqual([]);
  });
});

describe("doneToday", () => {
  const task = (id: string, status: string, updated: number, assignee: string | null = "planner") => ({
    id,
    title: `task ${id}`,
    status,
    assignee,
    updated_at: new Date(updated).toISOString().slice(0, 19).replace("T", " "),
  });

  it("is the tasks finished today and the last thing each agent did today, newest first", () => {
    const activities: Record<string, AgentActivity> = {
      writer: {
        agent: "writer",
        doing: "idle",
        what: "idle",
        last: { what: "searching the web", at: iso(at(0, 9, 30)) },
      },
      reviewer: { agent: "reviewer", doing: "idle", what: "idle", last: { what: "reading", at: iso(at(-1, 22)) } },
    };
    const done = doneToday(
      [
        task("a", "done", at(0, 8)),
        task("b", "done", at(-1, 20)),
        task("c", "in_progress", at(0, 9)),
        task("d", "done", at(0, 9), null),
      ],
      activities,
      now,
    );
    expect(done.map((d) => [d.agent, d.what])).toEqual([
      ["writer", "searched the web"],
      ["planner", "finished “task a”"],
    ]);
    expect(done[1].task).toBe("a");
  });
});

describe("byDay", () => {
  const wake = (key: string, when: number): Wake => ({ key, agent: "planner", at: when, kind: "booked", what: key });
  const name = (ms: number) => `day ${new Date(ms).getDate()}`;

  it("groups wakes under today, tomorrow, and the day after by its date", () => {
    const days = byDay(
      [wake("a", at(0, 11)), wake("b", at(0, 15)), wake("c", at(1, 9)), wake("d", at(3, 9))],
      now,
      name,
    );
    expect(days.map((d) => [d.label, d.wakes.map((w) => w.key)])).toEqual([
      ["Today", ["a", "b"]],
      ["Tomorrow", ["c"]],
      ["day 22", ["d"]],
    ]);
    expect(days[0].start).toBe(dayStart(now));
  });

  it("puts anything overdue under today", () => {
    expect(byDay([wake("late", at(-1, 23)), wake("a", at(0, 11))], now, name)).toHaveLength(1);
  });
});

describe("calendarLines", () => {
  const wakes = (n: number, day = 0): Wake[] =>
    Array.from({ length: n }, (_, i) => ({
      key: `w${day}-${i}`,
      agent: "planner",
      at: at(day, 11 + i),
      kind: "booked" as const,
      what: `wake ${i}`,
    }));
  const view = (over: Partial<CalendarView>): CalendarView => ({
    title: "planner's day",
    now,
    wakes: [],
    done: [],
    names: false,
    ...over,
  });
  const kinds = (lines: ReturnType<typeof calendarLines>) =>
    lines.map((l) =>
      l.kind === "wake" ? l.wake.key : l.kind === "day" ? `#${l.text}` : l.kind === "more" ? `+${l.count}` : l.kind,
    );

  it("lists each day's wakes under its heading", () => {
    const lines = calendarLines(view({ wakes: [...wakes(2), ...wakes(1, 1)] }), 10, () => "x");
    expect(kinds(lines)).toEqual(["#Today", "w0-0", "w0-1", "#Tomorrow", "w1-0"]);
  });

  it("says how many more there are when they don't all fit, never leaving a heading with nothing under it", () => {
    expect(kinds(calendarLines(view({ wakes: wakes(6) }), 4))).toEqual(["#Today", "w0-0", "w0-1", "+4"]);
    // Room for the first day and its count, but not for another heading and a wake under it.
    expect(kinds(calendarLines(view({ wakes: [...wakes(2), ...wakes(2, 1)] }), 4))).toEqual([
      "#Today",
      "w0-0",
      "w0-1",
      "+2",
    ]);
    // The last wake of all needs no room for a count after it.
    expect(kinds(calendarLines(view({ wakes: wakes(3) }), 4))).toEqual(["#Today", "w0-0", "w0-1", "w0-2"]);
  });

  it("keeps what got done today at the foot, and says when nothing is booked", () => {
    const done = [
      { key: "d1", agent: "planner", at: at(0, 9), what: "finished “a”" },
      { key: "d2", agent: "planner", at: at(0, 8), what: "finished “b”" },
      { key: "d3", agent: "planner", at: at(0, 7), what: "finished “c”" },
    ];
    expect(kinds(calendarLines(view({ done }), 8))).toEqual(["empty", "done-head", "done", "done"]);
    expect(kinds(calendarLines(view({ wakes: wakes(5), done }), 8))).toEqual([
      "#Today",
      "w0-0",
      "w0-1",
      "w0-2",
      "+2",
      "done-head",
      "done",
      "done",
    ]);
  });

  it("keeps room for two days' wakes before it gives any to what got done", () => {
    const done = [
      { key: "d1", agent: "planner", at: at(0, 9), what: "finished “a”" },
      { key: "d2", agent: "planner", at: at(0, 8), what: "finished “b”" },
    ];
    expect(kinds(calendarLines(view({ wakes: [...wakes(1), ...wakes(1, 1)], done }), 6))).toEqual([
      "#Today",
      "w0-0",
      "#Tomorrow",
      "w1-0",
      "done-head",
      "done",
    ]);
  });

  it("gives a small page to the wakes alone", () => {
    const done = [{ key: "d1", agent: "planner", at: at(0, 9), what: "finished “a”" }];
    expect(kinds(calendarLines(view({ wakes: wakes(1), done }), 4))).toEqual(["#Today", "w0-0"]);
  });
});

describe("a calendar read close up", () => {
  const now = new Date(2026, 9, 20, 15, 30).getTime();

  it("puts what got done on the days gone by: done, assigned, and last changed in the time asked about", () => {
    const at = (d: number) => new Date(2026, 9, d, 10).toISOString();
    const done = doneBetween(
      [
        { id: "a", title: "Plan", status: "done", assignee: "planner", updated_at: at(3) },
        { id: "b", title: "Draft", status: "done", assignee: "writer", updated_at: at(18) },
        { id: "c", title: "Open", status: "in_progress", assignee: "writer", updated_at: at(18) },
        { id: "d", title: "Nobody's", status: "done", assignee: null, updated_at: at(18) },
        {
          id: "e",
          title: "Last month",
          status: "done",
          assignee: "writer",
          updated_at: new Date(2026, 8, 20).toISOString(),
        },
      ],
      new Date(2026, 9, 1).getTime(),
      now,
    );
    expect(done.map((d) => d.task)).toEqual(["b", "a"]);
    expect(done[0]).toMatchObject({ agent: "writer", what: "finished “Draft”" });
  });

  it("lays out today alone, the week from today, or the month's whole weeks", () => {
    const day = calendarDays("day", now);
    expect(day).toEqual([{ start: dayStart(now), today: true, inMonth: true }]);
    const week = calendarDays("week", now);
    expect(week).toHaveLength(7);
    expect(week[0]?.today).toBe(true);
    expect(new Date(week[6]?.start ?? 0).getDate()).toBe(26);
    // October 2026 starts on a Thursday: Monday-first weeks begin on 28 September, and end with 1 November.
    const month = calendarDays("month", now, 1);
    expect(month.length % 7).toBe(0);
    expect(new Date(month[0]?.start ?? 0).getDate()).toBe(28);
    expect(month[0]?.inMonth).toBe(false);
    expect(month.filter((d) => d.inMonth)).toHaveLength(31);
    expect(new Date(month.at(-1)?.start ?? 0).getDate()).toBe(1);
    expect(month.filter((d) => d.today)).toHaveLength(1);
    // Sunday-first, it begins the Sunday before.
    expect(new Date(calendarDays("month", now, 0)[0]?.start ?? 0).getDate()).toBe(27);
  });

  it("finds what falls on a day: its wakes soonest first, what got done newest first", () => {
    const start = dayStart(now);
    const wake = (key: string, at: number): Wake => ({ key, agent: "planner", at, kind: "booked", what: key });
    const on = onDay(
      start,
      [
        wake("late", start + 20 * 3_600_000),
        wake("early", start + 8 * 3_600_000),
        wake("tomorrow", start + 30 * 3_600_000),
      ],
      [
        { key: "d1", agent: "writer", at: start + 9 * 3_600_000, what: "x" },
        { key: "d2", agent: "writer", at: start + 11 * 3_600_000, what: "y" },
        { key: "d0", agent: "writer", at: start - 3_600_000, what: "z" },
      ],
    );
    expect(on.wakes.map((w) => w.key)).toEqual(["early", "late"]);
    expect(on.done.map((d) => d.key)).toEqual(["d2", "d1"]);
  });
});
