import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AutopilotWorker } from "../autopilot/worker.js";
import { initDatabase } from "../db/schema.js";
import { createProjectTask, findStuckCodingTasks, updateProjectTask } from "../db/task-queries.js";

/**
 * Regression tests for the autopilot stuck-task scanner (Phase 6
 * follow-up: coder stall recovery). Two pieces:
 *   1. `findStuckCodingTasks` — SQL helper that selects non-terminal
 *      tasks assigned to an agent whose updated_at is older than the
 *      threshold.
 *   2. `AutopilotWorker.scanStuckTasks` — orchestrator that calls the
 *      helper and re-fires each stuck task via taskWatcher with
 *      `force: true`.
 */

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function backdate(taskId: string, secondsAgo: number) {
  db.prepare("UPDATE project_tasks SET updated_at = datetime('now', '-' || ? || ' seconds') WHERE id = ?").run(
    secondsAgo,
    taskId,
  );
}

describe("findStuckCodingTasks", () => {
  it("returns tasks where assignee is in the set AND updated_at is older than threshold", () => {
    const stuck = createProjectTask(db, { title: "stuck", assignee: "coder" });
    const fresh = createProjectTask(db, { title: "fresh", assignee: "coder" });
    backdate(stuck.id, 60 * 60); // 1h ago
    // fresh stays at NOW

    const found = findStuckCodingTasks(db, {
      assignees: ["coder", "reviewer"],
      thresholdMs: 30 * 60_000,
    });
    expect(found.map((t) => t.id)).toEqual([stuck.id]);
    expect(found.map((t) => t.id)).not.toContain(fresh.id);
  });

  it("excludes terminal statuses (done, archived, blocked)", () => {
    const done = createProjectTask(db, { title: "done", assignee: "coder" });
    const archived = createProjectTask(db, { title: "archived", assignee: "coder" });
    const blocked = createProjectTask(db, { title: "blocked", assignee: "coder" });
    updateProjectTask(db, done.id, { status: "done" });
    updateProjectTask(db, archived.id, { status: "archived" });
    updateProjectTask(db, blocked.id, { status: "blocked" });
    for (const id of [done.id, archived.id, blocked.id]) backdate(id, 60 * 60);

    const found = findStuckCodingTasks(db, {
      assignees: ["coder"],
      thresholdMs: 30 * 60_000,
    });
    expect(found).toHaveLength(0);
  });

  it("excludes assignees not in the agent set", () => {
    const human = createProjectTask(db, { title: "user-task", assignee: "Quinton" });
    backdate(human.id, 60 * 60);
    const found = findStuckCodingTasks(db, {
      assignees: ["coder", "reviewer"],
      thresholdMs: 30 * 60_000,
    });
    expect(found).toHaveLength(0);
  });

  it("returns empty when the assignees list is empty", () => {
    const t = createProjectTask(db, { title: "t", assignee: "coder" });
    backdate(t.id, 60 * 60);
    expect(findStuckCodingTasks(db, { assignees: [], thresholdMs: 1000 })).toHaveLength(0);
  });
});

describe("AutopilotWorker.scanStuckTasks", () => {
  function makeWorker(opts: { agents?: string[]; stuckThresholdMs?: number } = {}) {
    const calls: Array<{ taskId: string; force: boolean | undefined }> = [];
    const taskWatcher = {
      notify(event: { action: "updated"; task: { id: string } }, notifyOpts?: { force?: boolean }) {
        calls.push({ taskId: event.task.id, force: notifyOpts?.force });
      },
    };
    const runtime: any = {
      db,
      getConfig: () => ({
        agents: Object.fromEntries((opts.agents ?? ["coder", "reviewer"]).map((a) => [a, {}])),
      }),
      getTaskBackend: () => ({ name: "stub" }),
    };
    const worker = new AutopilotWorker({
      runtime,
      taskBackend: { name: "stub" } as any,
      getTaskWatcher: () => taskWatcher,
      stuckThresholdMs: opts.stuckThresholdMs ?? 30 * 60_000,
    });
    return { worker, calls };
  }

  it("re-fires every stuck task with force=true", async () => {
    const { worker, calls } = makeWorker();
    const t1 = createProjectTask(db, { title: "a", assignee: "coder" });
    const t2 = createProjectTask(db, { title: "b", assignee: "reviewer" });
    backdate(t1.id, 60 * 60);
    backdate(t2.id, 60 * 60);

    const result = await worker.scanStuckTasks();
    expect(result.requeued).toBe(2);
    expect(calls.map((c) => c.taskId).sort()).toEqual([t1.id, t2.id].sort());
    expect(calls.every((c) => c.force === true)).toBe(true);
  });

  it("ignores fresh tasks", async () => {
    const { worker, calls } = makeWorker({ stuckThresholdMs: 60 * 60_000 });
    createProjectTask(db, { title: "fresh", assignee: "coder" });
    const result = await worker.scanStuckTasks();
    expect(result.requeued).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("no-ops cleanly when no taskWatcher is wired", async () => {
    const runtime: any = {
      db,
      getConfig: () => ({ agents: { coder: {} } }),
      getTaskBackend: () => ({ name: "stub" }),
    };
    const worker = new AutopilotWorker({
      runtime,
      taskBackend: { name: "stub" } as any,
      getTaskWatcher: () => undefined,
    });
    const t = createProjectTask(db, { title: "x", assignee: "coder" });
    backdate(t.id, 60 * 60);
    const result = await worker.scanStuckTasks();
    expect(result.requeued).toBe(0);
  });
});
