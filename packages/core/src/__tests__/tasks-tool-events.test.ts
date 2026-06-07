/**
 * Slice 2 of the platform vision (`docs/platform-vision.md`): the `tasks`
 * tool emits typed `task.*` lifecycle events to the runtime event bus.
 * These tests verify that emissions land for the documented actions, that
 * a status change fans out an extra `task.transitioned` event, and that
 * the legacy `notify` callback keeps firing for back-compat.
 */
import { describe, expect, it, vi } from "vitest";
import { TypedEventBus } from "../events.js";
import type {
  Task,
  TaskBackend,
  TaskComment,
  TaskCreateInput,
  TaskFilter,
  TaskQueryResult,
  TaskUpdateInput,
} from "../tasks/interface.js";
import type { ToolContext } from "../tools/interface.js";
import { TasksTool } from "../tools/tasks.js";

class StubBackend implements TaskBackend {
  readonly name = "stub";
  readonly statuses = {
    backlog: "backlog",
    inProgress: "in_progress",
    blocked: "blocked",
    done: "done",
  };
  readonly extraStatuses = ["in_review", "archived"] as const;

  private tasks = new Map<string, Task>();
  private comments = new Map<string, TaskComment[]>();
  private seq = 0;

  isDone(s: string) {
    return s === "done" || s === "archived";
  }

  async create(input: TaskCreateInput): Promise<Task> {
    const id = `t-${++this.seq}`;
    const task: Task = {
      id,
      title: input.title,
      description: input.description ?? "",
      status: input.status ?? "backlog",
      author: input.author ?? "",
      tags: input.tags ?? [],
      assignee: input.assignee ?? null,
      rank: input.rank ?? 0,
      blocked_reason: null,
      project_id: input.project_id ?? null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.tasks.set(id, task);
    return task;
  }
  async get(id: string) {
    const t = this.tasks.get(id);
    return t ? { ...t, comments: this.comments.get(id) ?? [] } : undefined;
  }
  async update(id: string, patch: TaskUpdateInput) {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    const updated: Task = { ...t };
    if (patch.title !== undefined) updated.title = patch.title;
    if (patch.description !== undefined) updated.description = patch.description;
    if (patch.status !== undefined) updated.status = patch.status;
    if (patch.author !== undefined) updated.author = patch.author;
    if (patch.tags !== undefined) updated.tags = patch.tags;
    if (patch.assignee !== undefined) updated.assignee = patch.assignee;
    if (patch.rank !== undefined) updated.rank = patch.rank;
    if (patch.blocked_reason !== undefined) updated.blocked_reason = patch.blocked_reason;
    if (patch.project_id !== undefined) updated.project_id = patch.project_id;
    updated.updated_at = new Date().toISOString();
    this.tasks.set(id, updated);
    return updated;
  }
  async delete(id: string) {
    return this.tasks.delete(id);
  }
  async comment(id: string, content: string, author?: string): Promise<TaskComment | undefined> {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    const list = this.comments.get(id) ?? [];
    const c: TaskComment = {
      id: list.length + 1,
      task_id: id,
      author: author ?? "agent",
      content,
      created_at: new Date().toISOString(),
    };
    list.push(c);
    this.comments.set(id, list);
    return c;
  }
  async query(_filter?: TaskFilter): Promise<TaskQueryResult> {
    return { tasks: [...this.tasks.values()], total: this.tasks.size };
  }
  async nextBacklogTask() {
    return undefined;
  }
  async claimBacklog(id: string) {
    return this.tasks.get(id);
  }
  async unblockBudgetTasks() {
    return 0;
  }
}

const ctx: ToolContext = {
  sessionId: "test",
  workingDirectory: "/tmp",
  env: {},
  agentName: "tester",
};

describe("TasksTool — event emissions (Slice 2)", () => {
  it("emits task.created on a successful create", async () => {
    const events = new TypedEventBus();
    const created = vi.fn();
    events.on("task.created", created);

    const tool = new TasksTool(new StubBackend(), undefined, undefined, { events });
    const r = await tool.execute({ action: "create", title: "hello" }, ctx);
    expect(r.success).toBe(true);
    expect(created).toHaveBeenCalledTimes(1);
    expect(created.mock.calls[0][0]).toMatchObject({ taskId: expect.stringMatching(/^t-/) });
  });

  it("forwards project_id on task.created", async () => {
    const events = new TypedEventBus();
    const created = vi.fn();
    events.on("task.created", created);

    const backend = new StubBackend();
    const tool = new TasksTool(backend, undefined, undefined, { events });
    await tool.execute({ action: "create", title: "alt", project_id: "proj-1" }, ctx);
    expect(created.mock.calls[0][0]).toEqual({ taskId: "t-1", projectId: "proj-1" });
  });

  it("emits task.updated with the changed field list", async () => {
    const events = new TypedEventBus();
    const updated = vi.fn();
    events.on("task.updated", updated);

    const backend = new StubBackend();
    const t = await backend.create({ title: "orig" });
    const tool = new TasksTool(backend, undefined, undefined, { events });

    await tool.execute({ action: "update", id: t.id, title: "renamed" }, ctx);
    expect(updated).toHaveBeenCalledTimes(1);
    expect(updated.mock.calls[0][0]).toMatchObject({ taskId: t.id, changes: ["title"] });
  });

  it("emits task.updated AND task.transitioned on a status change", async () => {
    const events = new TypedEventBus();
    const updated = vi.fn();
    const transitioned = vi.fn();
    events.on("task.updated", updated);
    events.on("task.transitioned", transitioned);

    const backend = new StubBackend();
    const t = await backend.create({ title: "orig", status: "backlog" });
    const tool = new TasksTool(backend, undefined, undefined, { events });

    await tool.execute({ action: "update", id: t.id, status: "in_progress", comment: "starting" }, ctx);
    expect(updated).toHaveBeenCalledTimes(1);
    expect(updated.mock.calls[0][0].changes).toContain("status");
    expect(transitioned).toHaveBeenCalledTimes(1);
    expect(transitioned.mock.calls[0][0]).toMatchObject({
      taskId: t.id,
      from: "backlog",
      to: "in_progress",
    });
  });

  it("does NOT emit task.transitioned when status is unchanged", async () => {
    const events = new TypedEventBus();
    const transitioned = vi.fn();
    events.on("task.transitioned", transitioned);

    const backend = new StubBackend();
    const t = await backend.create({ title: "orig", status: "backlog" });
    const tool = new TasksTool(backend, undefined, undefined, { events });

    await tool.execute({ action: "update", id: t.id, title: "renamed" }, ctx);
    expect(transitioned).not.toHaveBeenCalled();
  });

  it("emits task.commented on the comment action", async () => {
    const events = new TypedEventBus();
    const commented = vi.fn();
    events.on("task.commented", commented);

    const backend = new StubBackend();
    const t = await backend.create({ title: "orig" });
    const tool = new TasksTool(backend, undefined, undefined, { events });

    await tool.execute({ action: "comment", id: t.id, text: "a note" }, ctx);
    expect(commented).toHaveBeenCalledTimes(1);
    expect(commented.mock.calls[0][0]).toMatchObject({ taskId: t.id });
  });

  it("emits task.commented from update when a status-change comment is posted", async () => {
    // Status changes via update REQUIRE a comment — that comment should
    // surface as a task.commented event so notifier plugins don't have to
    // know that the update path is special.
    const events = new TypedEventBus();
    const commented = vi.fn();
    events.on("task.commented", commented);

    const backend = new StubBackend();
    const t = await backend.create({ title: "orig", status: "backlog" });
    const tool = new TasksTool(backend, undefined, undefined, { events });

    await tool.execute({ action: "update", id: t.id, status: "in_progress", comment: "starting" }, ctx);
    expect(commented).toHaveBeenCalledTimes(1);
    expect(commented.mock.calls[0][0]).toMatchObject({ taskId: t.id });
  });

  it("does NOT emit when the update fails (task missing)", async () => {
    const events = new TypedEventBus();
    const updated = vi.fn();
    events.on("task.updated", updated);

    const tool = new TasksTool(new StubBackend(), undefined, undefined, { events });
    const r = await tool.execute({ action: "update", id: "missing", title: "x" }, ctx);
    expect(r.success).toBe(false);
    expect(updated).not.toHaveBeenCalled();
  });

  it("does NOT emit when the create has no title (validation fails)", async () => {
    const events = new TypedEventBus();
    const created = vi.fn();
    events.on("task.created", created);

    const tool = new TasksTool(new StubBackend(), undefined, undefined, { events });
    const r = await tool.execute({ action: "create" }, ctx);
    expect(r.success).toBe(false);
    expect(created).not.toHaveBeenCalled();
  });

  it("keeps the legacy notify callback firing alongside the event bus", async () => {
    const events = new TypedEventBus();
    const created = vi.fn();
    const notify = vi.fn();
    events.on("task.created", created);

    const tool = new TasksTool(new StubBackend(), undefined, notify, { events });
    await tool.execute({ action: "create", title: "both" }, ctx);
    expect(notify).toHaveBeenCalledWith("created", expect.any(String), undefined);
    expect(created).toHaveBeenCalledTimes(1);
  });

  it("emits nothing when no events bus is provided (back-compat)", async () => {
    // The TasksTool's old constructor shape (no opts) must still produce
    // exactly the previous behavior. Nothing to assert about emissions —
    // we just verify the surface still works.
    const notify = vi.fn();
    const tool = new TasksTool(new StubBackend(), undefined, notify);
    const r = await tool.execute({ action: "create", title: "legacy" }, ctx);
    expect(r.success).toBe(true);
    expect(notify).toHaveBeenCalled();
  });
});
