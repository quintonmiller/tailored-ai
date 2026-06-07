/**
 * CoderProjectGuard default-plugin tests — Slice 3 step 4 of the
 * platform vision (`docs/platform-vision.md`). Cover the veto + block
 * + comment behavior plus the EventBus.emitAsync extension that makes
 * synchronous causality possible.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProject } from "../db/project-queries.js";
import { initDatabase } from "../db/schema.js";
import { createProjectTask, getProjectTask } from "../db/task-queries.js";
import { TypedEventBus } from "../events.js";
import { CoderProjectGuard } from "../plugins/coder-project-guard.js";
import type { AgentRuntime } from "../runtime.js";

let db: Database.Database;

function makeRuntime(): AgentRuntime {
  const events = new TypedEventBus();
  return { db, events, getConfig: () => ({}) } as unknown as AgentRuntime;
}

function fireDispatch(
  runtime: AgentRuntime,
  args: { taskId: string; projectId: string | null; agentName: string | undefined },
) {
  return runtime.events.emitAsync("agent.dispatched", {
    taskId: args.taskId,
    projectId: args.projectId,
    agentName: args.agentName,
    task: { id: args.taskId, title: "T", status: "in_progress", assignee: args.agentName ?? null },
  });
}

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("CoderProjectGuard veto path", () => {
  it("vetoes when coder is dispatched without a project_id", async () => {
    const runtime = makeRuntime();
    new CoderProjectGuard({ runtime });
    const task = createProjectTask(db, { title: "no-proj", assignee: "coder" });

    const allowed = await fireDispatch(runtime, { taskId: task.id, projectId: null, agentName: "coder" });
    expect(allowed).toBe(false);

    const after = getProjectTask(db, task.id);
    expect(after?.status).toBe("blocked");
    expect(after?.blocked_reason).toContain("no project_id");
    const comments = db.prepare("SELECT author, content FROM task_comments WHERE task_id = ?").all(task.id) as Array<{
      author: string;
      content: string;
    }>;
    expect(comments.some((c) => c.author === "task-watcher" && c.content.startsWith("BLOCKED:"))).toBe(true);
  });

  it("vetoes when the project exists but has no path", async () => {
    const runtime = makeRuntime();
    new CoderProjectGuard({ runtime });
    createProject(db, { id: "proj_x", title: "NoPath", path: "" });
    const task = createProjectTask(db, { title: "needs-path", assignee: "reviewer", project_id: "proj_x" });

    const allowed = await fireDispatch(runtime, { taskId: task.id, projectId: "proj_x", agentName: "reviewer" });
    expect(allowed).toBe(false);
    const after = getProjectTask(db, task.id);
    expect(after?.status).toBe("blocked");
    expect(after?.blocked_reason).toContain("no path");
  });
});

describe("CoderProjectGuard allow path", () => {
  it("allows when the agent isn't coder or reviewer", async () => {
    const runtime = makeRuntime();
    new CoderProjectGuard({ runtime });
    const task = createProjectTask(db, { title: "T", assignee: "default" });
    const allowed = await fireDispatch(runtime, { taskId: task.id, projectId: null, agentName: "default" });
    expect(allowed).toBe(true);
    expect(getProjectTask(db, task.id)?.status).not.toBe("blocked");
  });

  it("allows when coder has a project_id and the project has a path", async () => {
    const runtime = makeRuntime();
    new CoderProjectGuard({ runtime });
    createProject(db, { id: "proj_ok", title: "OK", path: "/tmp/repo" });
    const task = createProjectTask(db, { title: "T", assignee: "coder", project_id: "proj_ok" });
    const allowed = await fireDispatch(runtime, { taskId: task.id, projectId: "proj_ok", agentName: "coder" });
    expect(allowed).toBe(true);
    expect(getProjectTask(db, task.id)?.status).not.toBe("blocked");
  });

  it("allows when agentName is undefined (default routing — no policy)", async () => {
    const runtime = makeRuntime();
    new CoderProjectGuard({ runtime });
    const task = createProjectTask(db, { title: "T", assignee: null });
    const allowed = await fireDispatch(runtime, { taskId: task.id, projectId: null, agentName: undefined });
    expect(allowed).toBe(true);
  });
});

describe("CoderProjectGuard lifecycle", () => {
  it("stop() disposes the subscription so later dispatches aren't vetoed", async () => {
    const runtime = makeRuntime();
    const guard = new CoderProjectGuard({ runtime });
    guard.stop();
    const task = createProjectTask(db, { title: "T", assignee: "coder" });
    const allowed = await fireDispatch(runtime, { taskId: task.id, projectId: null, agentName: "coder" });
    // Without the subscription, emitAsync returns true (no veto).
    expect(allowed).toBe(true);
    expect(getProjectTask(db, task.id)?.status).not.toBe("blocked");
  });
});

describe("TypedEventBus.emitAsync", () => {
  it("returns true when no handlers are registered", async () => {
    const bus = new TypedEventBus();
    const r = await bus.emitAsync("runtime.reloaded", { generation: 1 });
    expect(r).toBe(true);
  });

  it("returns true when every handler returns void / true", async () => {
    const bus = new TypedEventBus();
    bus.on("runtime.reloaded", () => {});
    bus.on("runtime.reloaded", async () => true);
    const r = await bus.emitAsync("runtime.reloaded", { generation: 1 });
    expect(r).toBe(true);
  });

  it("returns false when any handler returns false", async () => {
    const bus = new TypedEventBus();
    bus.on("runtime.reloaded", () => {});
    bus.on("runtime.reloaded", () => false);
    const r = await bus.emitAsync("runtime.reloaded", { generation: 1 });
    expect(r).toBe(false);
  });

  it("awaits async handlers sequentially in registration order", async () => {
    const bus = new TypedEventBus();
    const order: string[] = [];
    bus.on("runtime.reloaded", async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push("a");
    });
    bus.on("runtime.reloaded", async () => {
      order.push("b");
    });
    await bus.emitAsync("runtime.reloaded", { generation: 1 });
    expect(order).toEqual(["a", "b"]);
  });

  it("treats a throwing handler as NON-veto and logs the error", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const bus = new TypedEventBus();
    bus.on("runtime.reloaded", () => {
      throw new Error("boom");
    });
    const r = await bus.emitAsync("runtime.reloaded", { generation: 1 });
    expect(r).toBe(true);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
