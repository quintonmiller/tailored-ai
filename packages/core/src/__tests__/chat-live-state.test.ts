import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildChatLiveState, renderChatLiveState } from "../agent/chat-live-state.js";
import { initDatabase } from "../db/schema.js";
import { createProjectTask, updateProjectTask } from "../db/task-queries.js";
import { appendTickLog } from "../db/tick-log-queries.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("buildChatLiveState", () => {
  it("returns empty sections on a fresh DB", () => {
    const state = buildChatLiveState(db, "default", null);
    expect(state.recentTicks).toHaveLength(0);
    expect(state.inFlight.inProgressTasks).toHaveLength(0);
    expect(state.pending.topBacklog).toHaveLength(0);
  });

  it("surfaces material/delegate/workflow ticks but excludes noop", () => {
    appendTickLog(db, { tick_id: "a", agent: "default", kind: "material", summary: "did X" });
    appendTickLog(db, { tick_id: "b", agent: "default", kind: "delegate", summary: "asked researcher" });
    appendTickLog(db, { tick_id: "c", agent: "default", kind: "noop", summary: "nothing to do" });
    const state = buildChatLiveState(db, "default", null);
    const kinds = state.recentTicks.map((t) => t.kind).sort();
    expect(kinds).toEqual(["delegate", "material"]);
  });

  it("respects recentHoursBack cutoff", () => {
    appendTickLog(db, { tick_id: "old", agent: "default", kind: "material", summary: "ancient" });
    db.prepare("UPDATE tick_log SET created_at = datetime('now','-12 hours') WHERE tick_id = 'old'").run();
    appendTickLog(db, { tick_id: "fresh", agent: "default", kind: "material", summary: "recent" });
    const state = buildChatLiveState(db, "default", null, { recentHoursBack: 6 });
    expect(state.recentTicks.some((t) => t.tickId === "fresh")).toBe(true);
    expect(state.recentTicks.some((t) => t.tickId === "old")).toBe(false);
  });

  it("includes in_progress tasks but not other statuses", () => {
    const a = createProjectTask(db, { title: "Working on this" });
    updateProjectTask(db, a.id, { status: "in_progress" });
    createProjectTask(db, { title: "Still backlog" });
    const state = buildChatLiveState(db, "default", null);
    expect(state.inFlight.inProgressTasks).toHaveLength(1);
    expect(state.inFlight.inProgressTasks[0].title).toBe("Working on this");
  });

  it("computes ageDays on backlog items", () => {
    const t = createProjectTask(db, { title: "Old task" });
    db.prepare("UPDATE project_tasks SET created_at = datetime('now','-10 days') WHERE id = ?").run(t.id);
    const state = buildChatLiveState(db, "default", null);
    const found = state.pending.topBacklog.find((x) => x.id === t.id);
    expect(found?.ageDays).toBeGreaterThanOrEqual(9);
  });

  it("respects project_id scoping", () => {
    db.prepare("INSERT INTO projects (id, title) VALUES (?, ?), (?, ?)").run("proj_a", "A", "proj_b", "B");
    createProjectTask(db, { title: "Project A task", project_id: "proj_a" });
    createProjectTask(db, { title: "Project B task", project_id: "proj_b" });
    const state = buildChatLiveState(db, "default", "proj_a");
    expect(state.pending.topBacklog.some((t) => t.title === "Project A task")).toBe(true);
    expect(state.pending.topBacklog.some((t) => t.title === "Project B task")).toBe(false);
  });
});

describe("renderChatLiveState", () => {
  it("returns empty string when nothing to show", () => {
    const state = buildChatLiveState(db, "default", null);
    expect(renderChatLiveState(state)).toBe("");
  });

  it("renders recent ticks with relative time", () => {
    appendTickLog(db, { tick_id: "x", agent: "default", kind: "material", summary: "did the thing" });
    // Backdate slightly so the relative-time formatter shows minutes,
    // not "just now". Anything > 60 seconds gives "Nm ago".
    db.prepare("UPDATE tick_log SET created_at = datetime('now','-2 minutes') WHERE tick_id = 'x'").run();
    const state = buildChatLiveState(db, "default", null);
    const r = renderChatLiveState(state);
    expect(r).toContain("Recent ticks");
    expect(r).toContain("did the thing");
    expect(r).toMatch(/\d+m ago/);
  });

  it("renders backlog with task ids and ages", () => {
    createProjectTask(db, { title: "Some backlog item" });
    const state = buildChatLiveState(db, "default", null);
    const r = renderChatLiveState(state);
    expect(r).toContain("Top backlog");
    expect(r).toContain("Some backlog item");
  });
});
