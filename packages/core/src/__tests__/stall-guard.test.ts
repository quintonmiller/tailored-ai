/**
 * Stall guard default-plugin tests — Slice 3 step 3 of the platform
 * vision (`docs/platform-vision.md`). Cover the retry / block / re-emit
 * paths plus the helpers that used to live in task-watcher.ts before
 * Slice 3 extracted them.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDatabase } from "../db/schema.js";
import { addTaskComment, createProjectTask, getProjectTask } from "../db/task-queries.js";
import { TypedEventBus } from "../events.js";
import { countPriorStalls, formatStallComment, StallGuard } from "../plugins/stall-guard.js";
import type { AgentRuntime } from "../runtime.js";

let db: Database.Database;

function makeRuntime(maxStallRetries = 1): AgentRuntime {
  const events = new TypedEventBus();
  return {
    db,
    events,
    getConfig: () => ({
      agents: { coder: { description: "" } },
      taskWatcher: { maxStallRetries },
    }),
  } as unknown as AgentRuntime;
}

function emitStall(runtime: AgentRuntime, taskId: string, stallReason: string, preservedPath: string | null = null) {
  runtime.events.emit("agent.stalled", {
    taskId,
    agentName: "coder",
    action: "updated",
    task: { id: taskId, title: "T", status: "in_progress", assignee: "coder" },
    finalTask: { id: taskId, title: "T", status: "in_progress", assignee: "coder" },
    response: `[Agent stopped: ${stallReason}]`,
    stallReason,
    worktree: preservedPath
      ? { repoPath: "/tmp/r", worktreePath: "/tmp/wt", branch: "agent/T", preservedPath }
      : undefined,
  });
}

beforeEach(() => {
  db = initDatabase(":memory:");
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe("StallGuard retry path", () => {
  it("writes a STALL #1 comment and emits task.dispatch_requested on first stall", async () => {
    const runtime = makeRuntime(1);
    new StallGuard({ runtime });
    const dispatchSpy = vi.fn();
    runtime.events.on("task.dispatch_requested", dispatchSpy);

    const task = createProjectTask(db, { title: "T", assignee: "coder" });
    emitStall(runtime, task.id, "max tool rounds reached");

    // Let the synchronous handle() body finish (it's async via the bus).
    await Promise.resolve();
    await Promise.resolve();

    const comments = db
      .prepare("SELECT author, content FROM task_comments WHERE task_id = ? ORDER BY id")
      .all(task.id) as { author: string; content: string }[];
    expect(comments).toHaveLength(1);
    expect(comments[0].author).toBe("task-watcher");
    expect(comments[0].content).toMatch(/^STALL #1: max tool rounds reached/);

    // task.dispatch_requested fires after the 500ms delay.
    expect(dispatchSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy.mock.calls[0][0]).toMatchObject({
      taskId: task.id,
      reason: expect.stringContaining("stall retry #1"),
    });
  });

  it("respects an overridden maxStallRetries", async () => {
    const runtime = makeRuntime(0); // never retry
    new StallGuard({ runtime, maxStallRetries: 2 });

    const task = createProjectTask(db, { title: "T", assignee: "coder" });
    emitStall(runtime, task.id, "x");
    await Promise.resolve();
    await Promise.resolve();

    const after = getProjectTask(db, task.id);
    expect(after?.status).not.toBe("blocked"); // not blocked — retry path
  });
});

describe("StallGuard block path (out of retries)", () => {
  it("transitions to blocked + writes decompose hint + re-emits agent.completed", async () => {
    const runtime = makeRuntime(1);
    new StallGuard({ runtime });
    const completedSpy = vi.fn();
    runtime.events.on("agent.completed", completedSpy);

    const task = createProjectTask(db, { title: "T", assignee: "coder" });
    addTaskComment(db, task.id, { author: "task-watcher", content: "STALL #1: prior stall" });
    emitStall(runtime, task.id, "repeated identical tool calls");

    await Promise.resolve();
    await Promise.resolve();

    const after = getProjectTask(db, task.id);
    expect(after?.status).toBe("blocked");
    expect(after?.blocked_reason).toMatch(/coder-stalled after 2 attempts/);

    const comments = db
      .prepare("SELECT author, content FROM task_comments WHERE task_id = ? ORDER BY id")
      .all(task.id) as { author: string; content: string }[];
    // Pre-existing STALL #1, new STALL #2, decompose hint.
    expect(comments).toHaveLength(3);
    expect(comments[1].content).toMatch(/^STALL #2: repeated/);
    expect(comments[2].content).toMatch(/Two stalls in a row/);

    // Re-emit lets AgentNotifier (which only subscribes to agent.completed)
    // see the terminal blocked state.
    expect(completedSpy).toHaveBeenCalledTimes(1);
    expect(completedSpy.mock.calls[0][0]).toMatchObject({
      taskId: task.id,
      finalTask: expect.objectContaining({ status: "blocked" }),
    });
  });
});

describe("countPriorStalls", () => {
  it("returns 0 for a task with no stall comments", () => {
    const task = createProjectTask(db, { title: "T" });
    expect(countPriorStalls(db, task.id)).toBe(0);
  });

  it("returns the highest N from prior STALL #N comments", () => {
    const task = createProjectTask(db, { title: "T" });
    addTaskComment(db, task.id, { author: "task-watcher", content: "STALL #1: x" });
    addTaskComment(db, task.id, { author: "task-watcher", content: "STALL #3: y" });
    addTaskComment(db, task.id, { author: "task-watcher", content: "STALL #2: z" });
    expect(countPriorStalls(db, task.id)).toBe(3);
  });
});

describe("formatStallComment", () => {
  it("starts with STALL #N prefix", () => {
    expect(formatStallComment(1, "max rounds", null, null)).toMatch(/^STALL #1: max rounds/);
    expect(formatStallComment(5, "x", null, null)).toMatch(/^STALL #5: x/);
  });

  it("includes the worktree path and diff stat when provided", () => {
    const c = formatStallComment(1, "max rounds", "/tmp/wt/agent/abc", {
      status: " M src/foo.ts",
      stat: " src/foo.ts | 5 ++++-",
    });
    expect(c).toContain("/tmp/wt/agent/abc");
    expect(c).toContain("M src/foo.ts");
    expect(c).toContain("src/foo.ts | 5 ++++-");
  });

  it("notes when no file changes were made", () => {
    const c = formatStallComment(1, "max rounds", "/tmp/wt", { status: "", stat: "" });
    expect(c).toContain("No file changes were made");
  });
});

describe("StallGuard subscription lifecycle", () => {
  it("stop() disposes the subscription so later events are ignored", async () => {
    const runtime = makeRuntime(1);
    const guard = new StallGuard({ runtime });
    guard.stop();
    const task = createProjectTask(db, { title: "T", assignee: "coder" });
    emitStall(runtime, task.id, "x");
    await Promise.resolve();
    await Promise.resolve();
    // No comment written; subscription is gone.
    const comments = db.prepare("SELECT * FROM task_comments WHERE task_id = ?").all(task.id);
    expect(comments).toHaveLength(0);
  });
});
