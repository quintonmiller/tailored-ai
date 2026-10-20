/**
 * What agents did lately, for the widgets in the 3D world: the feed of turns,
 * tool uses, posts and finished tasks read from what the server keeps, the
 * numbers by the hour behind the charts, and time by activity tallied as the
 * activity records change.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db/schema.js";
import { TypedEventBus } from "../events.js";
import { ACTIVITY_SCHEMA, ACTIVITY_TYPE, ActivityTracker } from "../plugins/activity.js";
import {
  FEED_KEPT,
  glimpse,
  hourlyStats,
  hourOf,
  isoOf,
  recentFeed,
  TimeTally,
  timeKey,
} from "../plugins/activity-history.js";
import "../state/builtin.js";
import { StateService } from "../state/service.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

/** A session, and the agent the loop recorded spending tokens in it, so many minutes ago. */
function session(id: string, agent: string | null, minutesAgo = 5) {
  db.prepare("INSERT INTO sessions (id, key, model, provider) VALUES (?, ?, 'm', 'p')").run(id, `k:${id}`);
  db.prepare(
    "INSERT INTO token_usage (session_id, prompt_tokens, completion_tokens, agent, source, created_at) VALUES (?, 100, 20, ?, 'loop', datetime('now', ?))",
  ).run(id, agent, `-${minutesAgo} minutes`);
}

function message(sessionId: string, role: string, content: string | null, calls: unknown[] | null, minutesAgo: number) {
  db.prepare(
    "INSERT INTO messages (session_id, role, content, tool_calls, created_at) VALUES (?, ?, ?, ?, datetime('now', ?))",
  ).run(sessionId, role, content, calls ? JSON.stringify(calls) : null, `-${minutesAgo} minutes`);
}

const describeTool = (tool: string, args: Record<string, unknown>) =>
  tool === "web_search"
    ? { what: "searching the web", ...(typeof args.query === "string" ? { detail: args.query } : {}) }
    : { what: `using ${tool}` };

describe("the feed", () => {
  it("lists replies, tool uses, posts and finished tasks, newest first, each with its agent", () => {
    session("s1", "planner");
    session("s2", null);
    message("s1", "user", "find ferries", null, 10);
    message("s1", "assistant", null, [{ id: "c1", name: "web_search", arguments: { query: "ferries to Belém" } }], 9);
    message("s1", "tool", "results", null, 9);
    message(
      "s1",
      "assistant",
      null,
      [{ id: "c2", name: "room", arguments: { action: "post", room: "local:trip", body: "Ferries every 20 min" } }],
      8,
    );
    message("s1", "assistant", "Found them.\nMore below.", null, 7);
    message("s2", "assistant", "Hello there", null, 6);
    db.prepare(
      "INSERT INTO project_tasks (id, title, status, assignee, updated_at) VALUES ('t1', 'Book the ferry', 'done', 'planner', datetime('now', '-3 minutes'))",
    ).run();
    db.prepare(
      "INSERT INTO project_tasks (id, title, status, assignee, updated_at) VALUES ('t2', 'Still open', 'in_progress', 'planner', datetime('now', '-2 minutes'))",
    ).run();

    const feed = recentFeed(db, describeTool);
    expect(feed.map((i) => [i.kind, i.agent, i.text])).toEqual([
      ["done", "planner", "Book the ferry"],
      ["turn", "default", "Hello there"],
      ["turn", "planner", "Found them."],
      ["post", "planner", "Ferries every 20 min"],
      ["tool", "planner", "searching the web"],
    ]);
    expect(feed[0]?.task).toBe("t1");
    expect(feed[3]?.room).toBe("local:trip");
    expect(feed[4]?.detail).toBe("ferries to Belém");
    expect(feed[4]?.at).toMatch(/Z$/);
  });

  it("leaves out sessions no agent spent tokens in lately, and what is older than it looks back", () => {
    db.prepare("INSERT INTO sessions (id, key, model, provider) VALUES ('old', 'k:old', 'm', 'p')").run();
    message("old", "assistant", "From nowhere", null, 5);
    session("s1", "writer");
    message("s1", "assistant", "Long ago", null, 60 * 72);
    message("s1", "assistant", "Just now", null, 1);
    expect(recentFeed(db, describeTool).map((i) => i.text)).toEqual(["Just now"]);
  });

  it("keeps at most so many, and reads tool arguments the loop kept as text", () => {
    session("s1", "planner");
    message("s1", "assistant", null, [{ id: "c", name: "web_search", arguments: '{"query":"tram 28"}' }], 2);
    for (let i = 0; i < FEED_KEPT + 10; i++) message("s1", "assistant", `line ${i}`, null, 1);
    const feed = recentFeed(db, describeTool);
    expect(feed).toHaveLength(FEED_KEPT);
    expect(recentFeed(db, describeTool, { limit: 500 }).find((i) => i.kind === "tool")?.detail).toBe("tram 28");
  });

  it("cuts what was said to its first line with words in it", () => {
    expect(glimpse("\n\n  First   line  \nsecond")).toBe("First line");
    expect(glimpse("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
    expect(glimpse(undefined)).toBe("");
    expect(isoOf("2026-10-20 05:33:31")).toBe("2026-10-20T05:33:31Z");
  });
});

describe("numbers by the hour", () => {
  it("sums tokens and model calls by agent and hour, counts turns in the sessions that spent them, and tasks done", () => {
    session("s1", "planner", 30);
    db.prepare(
      "INSERT INTO token_usage (session_id, prompt_tokens, completion_tokens, agent, source, created_at) VALUES ('s1', 50, 5, 'planner', 'loop', datetime('now', '-30 minutes'))",
    ).run();
    session("s2", "writer", 60 * 30);
    message("s1", "user", "go", null, 30);
    message("s1", "user", "again", null, 30);
    message("s2", "user", "long ago", null, 60 * 30);
    db.prepare(
      "INSERT INTO project_tasks (id, title, status, assignee, updated_at) VALUES ('t1', 'Done', 'done', 'writer', datetime('now', '-30 minutes'))",
    ).run();
    const stats = hourlyStats(db, 1);
    expect(stats.tokens).toHaveLength(1);
    expect(stats.tokens[0]).toMatchObject({ agent: "planner", prompt: 150, completion: 25, calls: 2 });
    expect(stats.tokens[0]?.hour).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/);
    expect(stats.turns).toEqual([{ hour: stats.tokens[0]?.hour, agent: "planner", n: 2 }]);
    expect(stats.done).toEqual([expect.objectContaining({ agent: "writer", n: 1 })]);
    expect(
      hourlyStats(db, 2)
        .tokens.map((t) => t.agent)
        .sort(),
    ).toEqual(["planner", "writer"]);
  });
});

describe("time by activity", () => {
  const H = 3_600_000;
  const t0 = Date.parse("2026-10-20T09:40:00Z");

  it("counts a stretch toward what it was, split at the hour so no hour holds more than an hour", () => {
    const tally = new TimeTally(t0 - H);
    tally.add("planner", "searching the web", t0, t0 + 50 * 60_000);
    expect(tally.rows([], t0 + 2 * H)).toEqual([
      { hour: "2026-10-20T09:00:00Z", agent: "planner", what: "searching the web", ms: 20 * 60_000 },
      { hour: "2026-10-20T10:00:00Z", agent: "planner", what: "searching the web", ms: 30 * 60_000 },
    ]);
  });

  it("counts nothing from before it began, and what is going on now up to now without keeping it", () => {
    const tally = new TimeTally(t0);
    tally.add("writer", "writing", t0 - H, t0 + 10 * 60_000);
    const ongoing = [{ agent: "writer", what: "thinking", since: t0 + 10 * 60_000 }];
    expect(tally.rows(ongoing, t0 + 15 * 60_000)).toEqual([
      { hour: "2026-10-20T09:00:00Z", agent: "writer", what: "writing", ms: 10 * 60_000 },
      { hour: "2026-10-20T09:00:00Z", agent: "writer", what: "thinking", ms: 5 * 60_000 },
    ]);
    expect(tally.rows([], t0 + 15 * 60_000)).toHaveLength(1);
  });

  it("forgets hours older than the days it keeps", () => {
    const tally = new TimeTally(t0 - 30 * 24 * H, 2);
    tally.add("planner", "thinking", t0 - 10 * 24 * H, t0 - 10 * 24 * H + 60_000);
    tally.add("planner", "thinking", t0, t0 + 60_000);
    expect(tally.rows([], t0 + H).map((r) => r.hour)).toEqual([hourOf(t0)]);
  });

  it("counts the tool's words while working, what it was doing otherwise, and never idle or asleep", () => {
    expect(timeKey({ doing: "working", what: "searching the web" })).toBe("searching the web");
    expect(timeKey({ doing: "thinking", what: "thinking" })).toBe("thinking");
    expect(timeKey({ doing: "waiting", what: "has a question for you" })).toBe("waiting on you");
    expect(timeKey({ doing: "idle", what: "idle" })).toBeUndefined();
    expect(timeKey({ doing: "asleep", what: "asleep" })).toBeUndefined();
  });

  it("is tallied by the activity tracker as one activity gives way to the next", async () => {
    const events = new TypedEventBus();
    const state = new StateService({
      getConfig: () => ({
        state: {
          backend: "sqlite",
          types: [
            {
              name: ACTIVITY_TYPE,
              scope: "global",
              provider: "memory",
              schema: ACTIVITY_SCHEMA as never,
              access: { write: [] },
            },
          ],
        },
      }),
      db,
    });
    let now = t0;
    const tally = new TimeTally(t0 - H);
    const tracker = new ActivityTracker({
      events,
      state: () => state,
      agents: () => ["planner"],
      asleep: () => null,
      settleMs: 0,
      tally,
      now: () => new Date(now),
    });
    await tracker.start();
    events.emit("agent.turn_started", { sessionId: "s1", agent: "planner", projectId: null });
    await tracker.settled();
    now = t0 + 4 * 60_000;
    events.emit("agent.turn_ended", { sessionId: "s1", agent: "planner", projectId: null });
    await tracker.settled();
    const rows = tally.rows([], now);
    expect(rows).toEqual([{ hour: "2026-10-20T09:00:00Z", agent: "planner", what: "thinking", ms: 4 * 60_000 }]);
    tracker.stop();
  });
});
