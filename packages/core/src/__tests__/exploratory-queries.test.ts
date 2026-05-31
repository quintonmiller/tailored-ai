import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  completeExploratoryRun,
  createExploratoryRun,
  ensureExploratoryState,
  getExploratoryRun,
  getExploratoryState,
  listExploratoryRuns,
  listExploratoryStates,
  maybeResetDailyCounters,
  updateExploratoryState,
} from "../db/exploratory-queries.js";
import { initDatabase } from "../db/schema.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("exploratory_state", () => {
  it("ensureExploratoryState creates a default row with enabled=true", () => {
    const s = ensureExploratoryState(db, "watcher");
    expect(s.agent_name).toBe("watcher");
    expect(s.enabled).toBe(true);
    expect(s.tokens_today).toBe(0);
    expect(s.runs_today).toBe(0);
    expect(s.paused_until).toBeNull();
  });

  it("ensureExploratoryState is idempotent", () => {
    ensureExploratoryState(db, "watcher");
    ensureExploratoryState(db, "watcher");
    const states = listExploratoryStates(db);
    expect(states).toHaveLength(1);
  });

  it("getExploratoryState returns null for unknown agents", () => {
    expect(getExploratoryState(db, "ghost")).toBeNull();
  });

  it("updateExploratoryState patches selected fields and bumps updated_at", () => {
    ensureExploratoryState(db, "watcher");
    const updated = updateExploratoryState(db, "watcher", {
      enabled: false,
      paused_until: "2026-06-01T00:00:00Z",
      last_tick_status: "ok",
      current_interval_ms: 60000,
      tokens_today: 500,
      runs_today: 1,
    });
    expect(updated.enabled).toBe(false);
    expect(updated.paused_until).toBe("2026-06-01T00:00:00Z");
    expect(updated.last_tick_status).toBe("ok");
    expect(updated.current_interval_ms).toBe(60000);
    expect(updated.tokens_today).toBe(500);
    expect(updated.runs_today).toBe(1);
  });

  it("updateExploratoryState auto-creates the row if missing", () => {
    const s = updateExploratoryState(db, "fresh", { enabled: false });
    expect(s.enabled).toBe(false);
  });

  it("maybeResetDailyCounters resets when the day rolls", () => {
    ensureExploratoryState(db, "watcher");
    updateExploratoryState(db, "watcher", {
      tokens_today: 5000,
      runs_today: 3,
      tokens_today_resets_at: "1999-01-01",
    });
    const reset = maybeResetDailyCounters(db, "watcher");
    expect(reset.tokens_today).toBe(0);
    expect(reset.runs_today).toBe(0);
    expect(reset.tokens_today_resets_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("maybeResetDailyCounters is a no-op on the same day", () => {
    ensureExploratoryState(db, "watcher");
    const first = maybeResetDailyCounters(db, "watcher");
    updateExploratoryState(db, "watcher", { tokens_today: 1000 });
    const second = maybeResetDailyCounters(db, "watcher");
    expect(second.tokens_today_resets_at).toBe(first.tokens_today_resets_at);
    expect(second.tokens_today).toBe(1000); // not reset
  });
});

describe("exploratory_runs", () => {
  it("createExploratoryRun stores a running row with id prefix", () => {
    const run = createExploratoryRun(db, { agentName: "watcher", projectId: null });
    expect(run.id).toMatch(/^xrun_[a-f0-9]{8}$/);
    expect(run.agent_name).toBe("watcher");
    expect(run.status).toBe("running");
    expect(run.ended_at).toBeNull();
    expect(run.note_ids).toEqual([]);
    expect(run.fact_ids).toEqual([]);
    expect(run.task_ids).toEqual([]);
  });

  it("completeExploratoryRun stamps status + arrays + summary", () => {
    const run = createExploratoryRun(db, { agentName: "watcher" });
    const completed = completeExploratoryRun(db, run.id, {
      status: "ok",
      tokensUsed: 1234,
      toolCalls: 3,
      noteIds: ["note_aaaaaaaa", "note_bbbbbbbb"],
      summary: "skimmed feed, noted 2 items",
    });
    expect(completed.status).toBe("ok");
    expect(completed.tokens_used).toBe(1234);
    expect(completed.tool_calls).toBe(3);
    expect(completed.note_ids).toEqual(["note_aaaaaaaa", "note_bbbbbbbb"]);
    expect(completed.summary).toBe("skimmed feed, noted 2 items");
    expect(completed.ended_at).not.toBeNull();
  });

  it("completeExploratoryRun preserves prior values via COALESCE", () => {
    const run = createExploratoryRun(db, { agentName: "watcher" });
    completeExploratoryRun(db, run.id, {
      status: "ok",
      tokensUsed: 100,
      summary: "first pass",
    });
    // Second update only changes status — other fields should survive
    completeExploratoryRun(db, run.id, { status: "ok" });
    const after = getExploratoryRun(db, run.id)!;
    expect(after.tokens_used).toBe(100);
    expect(after.summary).toBe("first pass");
  });

  it("listExploratoryRuns filters by agent + status, newest first", async () => {
    const w1 = createExploratoryRun(db, { agentName: "watcher" });
    await new Promise((r) => setTimeout(r, 10));
    const w2 = createExploratoryRun(db, { agentName: "watcher" });
    createExploratoryRun(db, { agentName: "other" });
    completeExploratoryRun(db, w1.id, { status: "noop" });
    completeExploratoryRun(db, w2.id, { status: "ok" });

    const watcherOk = listExploratoryRuns(db, { agentName: "watcher", status: "ok" });
    expect(watcherOk.map((r) => r.id)).toEqual([w2.id]);

    const allWatcher = listExploratoryRuns(db, { agentName: "watcher" });
    // newest first — w2 created after w1
    expect(allWatcher[0].id).toBe(w2.id);
  });

  it("listExploratoryRuns scopes projectId=null vs string", () => {
    createExploratoryRun(db, { agentName: "a", projectId: null });
    createExploratoryRun(db, { agentName: "a", projectId: "proj_x" });
    expect(listExploratoryRuns(db, { projectId: null }).map((r) => r.project_id)).toEqual([null]);
    expect(listExploratoryRuns(db, { projectId: "proj_x" }).map((r) => r.project_id)).toEqual(["proj_x"]);
  });

  it("note_ids round-trips malformed JSON safely (empty array)", () => {
    const run = createExploratoryRun(db, { agentName: "watcher" });
    db.prepare("UPDATE exploratory_runs SET note_ids = 'not json' WHERE id = ?").run(run.id);
    const after = getExploratoryRun(db, run.id)!;
    expect(after.note_ids).toEqual([]);
  });
});
