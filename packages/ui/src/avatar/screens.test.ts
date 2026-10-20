/**
 * A screen on a wall: which of the dashboard's widgets it goes through and in
 * what order, each drawn as a page from what its endpoint sent, a new page
 * every quarter of a minute read off the clock; and in a home, the pages
 * about its owner.
 */
import { describe, expect, it, vi } from "vitest";
import type { DashboardWidgetSpec } from "../api";
import { clockTime } from "../lib/did";
import type { AgentActivity } from "./doing";
import {
  cardFor,
  dashboardCards,
  endpointOf,
  homeCards,
  PAGE_MS,
  pageAt,
  plainLines,
  rowsFit,
  screenWidgets,
  twoLines,
} from "./screens";

const widget = (id: string, type: string, options?: Record<string, unknown>): DashboardWidgetSpec => ({
  id,
  type,
  title: id,
  ...(options ? { options } : {}),
});

describe("screenWidgets", () => {
  it("goes through the dashboard's widgets in its order, leaving out what a screen can't draw", () => {
    const widgets = [
      widget("clock", "clock"),
      widget("embed", "iframe", { url: "https://example.com" }),
      widget("status", "status"),
      widget("explorer", "session-explorer"),
      widget("needs", "tasks"),
      widget("off", "metric", {}),
      widget("runs", "activity"),
    ];
    widgets[5].enabled = false;
    expect(screenWidgets(widgets).map((w) => w.id)).toEqual(["clock", "status", "needs", "runs"]);
  });

  it("shows only the first few", () => {
    const many = Array.from({ length: 9 }, (_, i) => widget(`w${i}`, "list"));
    expect(screenWidgets(many).map((w) => w.id)).toEqual(["w0", "w1", "w2", "w3", "w4"]);
    expect(screenWidgets(many, 2)).toHaveLength(2);
  });
});

describe("endpointOf", () => {
  it("is the widget's own endpoint, or the one its renderer reads by default", () => {
    expect(endpointOf(widget("s", "status"))).toBe("/api/health");
    expect(endpointOf(widget("t", "tasks", { endpoint: "/api/project-tasks?status=blocked" }))).toBe(
      "/api/project-tasks?status=blocked",
    );
    expect(endpointOf(widget("c", "clock"))).toBeUndefined();
    expect(endpointOf(widget("m", "markdown", { markdown: "# hi" }))).toBeUndefined();
  });

  it("never reads anything but the server's own API", () => {
    expect(endpointOf(widget("x", "list", { endpoint: "https://elsewhere.example/feed" }))).toBeUndefined();
  });
});

describe("pageAt", () => {
  it("turns to the next page every quarter of a minute, and round again", () => {
    const start = 1_000 * PAGE_MS;
    expect([0, 1, 2, 3].map((k) => pageAt(start + k * PAGE_MS, 3))).toEqual([1, 2, 0, 1]);
    expect(pageAt(start + PAGE_MS - 1, 3)).toBe(pageAt(start, 3));
  });

  it("stays on the one page there is, or none", () => {
    expect(pageAt(123_456_789, 1)).toBe(0);
    expect(pageAt(123_456_789, 0)).toBe(0);
  });
});

describe("cardFor", () => {
  const now = Date.UTC(2026, 9, 19, 12);

  it("says the system is online, with its model and how long it has been up", () => {
    const card = cardFor(widget("status", "status"), {
      data: { status: "ok", model: "a-model", provider: "local", uptime: 2 * 3600, tools: 12 },
    });
    expect(card.big).toEqual({ text: "Online", tone: "ok" });
    expect(card.rows).toEqual([
      { text: "Model", meta: "a-model" },
      { text: "Provider", meta: "local" },
      { text: "Up for", meta: "2 h" },
      { text: "Tools", meta: "12" },
    ]);
    expect(cardFor(widget("status", "status"), { error: "502" }).big).toEqual({ text: "Unreachable", tone: "bad" });
  });

  it("lists tasks with their status as a tag and who has them", () => {
    const card = cardFor(widget("needs", "tasks", { emptyText: "Nothing needs you." }), {
      data: {
        tasks: [
          { id: "a", title: "Approve the budget", status: "blocked", assignee: "planner" },
          { id: "b", title: "Review the draft", status: "in_review" },
        ],
      },
    });
    expect(card.rows).toEqual([
      { text: "Approve the budget", meta: "planner", tag: { text: "Blocked", tone: "bad" } },
      { text: "Review the draft", tag: { text: "In review", tone: "info" } },
    ]);
    expect(
      cardFor(widget("needs", "tasks", { emptyText: "Nothing needs you." }), { data: { tasks: [] } }),
    ).toMatchObject({ rows: [], empty: "Nothing needs you." });
  });

  it("shows recent runs by agent, time and outcome", () => {
    const at = new Date(now).toISOString();
    const card = cardFor(widget("runs", "activity"), {
      data: {
        runs: [
          { agent: "planner", started_at: at, outcome: "error" },
          { agentName: "writer", status: "ok" },
        ],
      },
    });
    expect(card.rows?.[0]).toMatchObject({ text: "planner", tag: { text: "error", tone: "bad" } });
    expect(card.rows?.[0].meta).toMatch(/\d/);
    expect(card.rows?.[1]).toEqual({ text: "writer", tag: { text: "ok", tone: "ok" } });
    // As the run store sends them: its own name for the agent, and UTC with nothing to say so. On a clock off UTC,
    // where a time read as local is hours out: CI's is on UTC, where it would be right by chance.
    vi.stubEnv("TZ", "America/New_York");
    try {
      const stored = cardFor(widget("runs", "activity"), {
        data: { runs: [{ agent_name: "scout", started_at: "2026-10-19 12:00:00", status: "noop" }] },
      });
      expect(clockTime(now)).toMatch(/^0?8:00/);
      expect(stored.rows?.[0]).toMatchObject({ text: "scout", meta: clockTime(now), tag: { tone: "dim" } });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("makes a metric one big number, with its unit and what it counts", () => {
    const card = cardFor(
      widget("queue", "metric", { endpoint: "/api/x", valuePath: "stats.pending", unit: "jobs", label: "waiting" }),
      {
        data: { stats: { pending: 7 } },
      },
    );
    expect(card.big).toEqual({ text: "7 jobs", sub: "waiting" });
  });

  it("reads a list's fields, and a markdown note as plain lines", () => {
    const list = cardFor(
      widget("reading", "list", {
        endpoint: "/api/facts",
        itemsPath: "facts",
        titleField: "entity",
        subtitleField: "value",
      }),
      {
        data: { facts: [{ entity: "Dune", value: "p.142" }, { entity: "Emma" }] },
      },
    );
    expect(list.rows).toEqual([{ text: "Dune", meta: "p.142" }, { text: "Emma" }]);
    const note = cardFor(
      widget("note", "markdown", { markdown: "# Today\n\n- **ship** the [notes](#/x)\n- rest" }),
      undefined,
    );
    expect(note.lines).toEqual(["Today", "• ship the notes", "• rest"]);
  });

  it("says it is loading until its endpoint answers, and why it couldn't when it can't", () => {
    expect(cardFor(widget("runs", "activity"), undefined)).toMatchObject({ empty: "Loading…" });
    expect(cardFor(widget("runs", "activity"), { error: "timeout" })).toMatchObject({
      empty: "Couldn't load: timeout",
    });
  });

  it("draws a clock with the time it is drawn at, and needs nothing fetched for it", () => {
    expect(cardFor(widget("clock", "clock"), undefined)).toEqual({ id: "clock", title: "clock", clock: true });
  });
});

describe("dashboardCards", () => {
  it("is a page for each widget a screen can draw, with what its endpoint sent", () => {
    const cards = dashboardCards({
      widgets: [widget("embed", "iframe"), widget("clock", "clock"), widget("runs", "activity")],
      fetched: { runs: { data: { runs: [{ agent: "planner", status: "ok" }] } } },
      loaded: true,
    });
    expect(cards.map((c) => c.id)).toEqual(["clock", "runs"]);
    expect(cards[1].rows?.[0]).toMatchObject({ text: "planner" });
  });

  it("is nothing until the dashboard answers, so the screen stays dark rather than say what isn't so", () => {
    expect(dashboardCards({ widgets: [], fetched: {}, loaded: false })).toEqual([]);
  });

  it("says why there is nothing once it has: no widgets, none a screen can draw, or it couldn't be had", () => {
    expect(dashboardCards({ widgets: [], fetched: {}, loaded: true })).toEqual([
      { id: "board", title: "Dashboard", empty: "Nothing on the Board yet." },
    ]);
    expect(dashboardCards({ widgets: [widget("embed", "iframe")], fetched: {}, loaded: true })[0].empty).toMatch(
      /Nothing on the Board a screen can show/,
    );
    expect(dashboardCards({ widgets: [], fetched: {}, loaded: true, error: "500 Internal" })[0].empty).toBe(
      "Couldn't load the dashboard: 500 Internal",
    );
  });
});

describe("plainLines", () => {
  it("keeps the words and drops the marks, up to a few lines", () => {
    expect(plainLines("## A\n1. one\n* two\n`three`", 3)).toEqual(["A", "one", "• two"]);
  });
});

describe("rowsFit", () => {
  it("fits as many rows as there is room for, keeping the last for the count of the rest", () => {
    expect(rowsFit(3, 100, 1000, 1000)).toMatchObject({ rowH: 150, shown: 3 });
    // A status page's four rows under its big word close up to fit, rather than one being left off.
    expect(rowsFit(4, 430, 928, 1000)).toMatchObject({ shown: 4 });
    const { rowH, shown } = rowsFit(40, 100, 1000, 1000);
    expect(rowH).toBe(110);
    expect(shown).toBe(Math.floor(900 / rowH) - 1);
    expect(shown).toBeGreaterThanOrEqual(5);
  });
});

describe("homeCards", () => {
  const now = Date.UTC(2026, 9, 19, 12);
  const idle: AgentActivity = {
    agent: "planner",
    doing: "idle",
    what: "idle",
    since: new Date(now - 30 * 60_000).toISOString(),
    last: { what: "searching the web", at: new Date(now - 40 * 60_000).toISOString() },
  };
  const tasks = [
    { id: "a", title: "Book flights", status: "backlog", assignee: "planner" },
    { id: "b", title: "Pack", status: "done", assignee: "planner" },
    { id: "c", title: "Write it up", status: "in_progress", assignee: "writer" },
  ];

  it("goes through what it is doing, its open tasks, and what is coming up, each opening its own thing", () => {
    const cards = homeCards("planner", {
      activity: idle,
      tasks,
      coming: [{ when: "14:30", what: "check the deploy" }],
      now,
    });
    expect(cards.map((c) => c.id)).toEqual(["now", "tasks", "next"]);
    expect(cards[0]).toMatchObject({ title: "planner, now", big: { text: "idle", tone: "dim" } });
    expect(cards[0].lines?.[0]).toMatch(/^last: searched the web/);
    // When it next wakes is the first of what is coming up, as its calendar has it.
    expect(cards[0].lines?.[1]).toBe("next: 14:30, check the deploy");
    expect(cards[1].rows).toEqual([{ text: "Book flights", tag: { text: "To do", tone: "dim" } }]);
    expect(cards[2].rows).toEqual([{ text: "check the deploy", meta: "14:30" }]);
  });

  it("says how long it has been at what it is busy with", () => {
    const busy: AgentActivity = { ...idle, doing: "working", what: "writing code", detail: "the parser" };
    const [doing] = homeCards("planner", { activity: busy, tasks: [], coming: [], now });
    expect(doing.big).toEqual({ text: "writing code", tone: "ok" });
    expect(doing.lines).toEqual(["the parser", "for 30 min"]);
  });

  it("says so when there is nothing on its list and nothing booked", () => {
    const [, list, next] = homeCards("writer", { tasks: [], coming: [], now });
    expect(list).toMatchObject({ rows: [], empty: "Nothing on its list." });
    expect(next).toMatchObject({ rows: [], empty: "Nothing booked." });
  });
});

describe("twoLines", () => {
  // A character's width in a test: one unit each.
  const width = (t: string) => t.length;

  it("breaks between words, and cuts the second line short when it all doesn't fit", () => {
    expect(twoLines("Ferries every twenty minutes", 30, width)).toEqual(["Ferries every twenty minutes"]);
    expect(twoLines("Ferries every twenty minutes", 16, width)).toEqual(["Ferries every", "twenty minutes"]);
    expect(twoLines("Ferries leave every twenty minutes from the quay", 16, width)).toEqual([
      "Ferries leave",
      "every twenty mi…",
    ]);
  });

  it("puts a word longer than a line on the first line by itself", () => {
    expect(twoLines("Supercalifragilistic word", 10, width)[0]).toBe("Supercalifragilistic");
  });
});
