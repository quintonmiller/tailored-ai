import { describe, expect, it } from "vitest";
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
import { type TaskBackendResolver, TaskQueryTool, TasksTool } from "../tools/tasks.js";

/**
 * Verifies the per-project task-backend routing introduced for multi-repo
 * setups (e.g. a personal SQLite default plus separate GitHub backends for
 * the `tai` and `tai-personal` projects). The resolver is the single
 * extension point; this test exercises it through both TasksTool and
 * TaskQueryTool to confirm `project_id` selects the backend at call time.
 *
 * The backends are minimal in-memory stubs so the test stays focused on
 * routing (not SQL FK constraints, not GitHub API mocking).
 */

class StubBackend implements TaskBackend {
  readonly name: string;
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

  // Trail of every call so tests can assert routing.
  public calls: Array<{ op: string; id?: string }> = [];

  constructor(name: string) {
    this.name = name;
  }

  isDone(status: string): boolean {
    return status === "done" || status === "archived";
  }

  async create(input: TaskCreateInput): Promise<Task> {
    this.calls.push({ op: "create" });
    const id = `${this.name}-${++this.seq}`;
    const task: Task = {
      id,
      title: input.title,
      description: input.description ?? "",
      status: input.status ?? "backlog",
      author: input.author ?? "",
      tags: input.tags ?? [],
      assignee: input.assignee ?? null,
      rank: input.rank ?? this.seq,
      blocked_reason: null,
      project_id: input.project_id ?? null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.tasks.set(id, task);
    this.comments.set(id, []);
    return task;
  }

  async get(id: string): Promise<Task | undefined> {
    this.calls.push({ op: "get", id });
    const task = this.tasks.get(id);
    if (!task) return undefined;
    return { ...task, comments: this.comments.get(id) ?? [] };
  }

  async update(id: string, patch: TaskUpdateInput): Promise<Task | undefined> {
    this.calls.push({ op: "update", id });
    const existing = this.tasks.get(id);
    if (!existing) return undefined;
    const updated: Task = {
      ...existing,
      ...patch,
      assignee: patch.assignee === undefined ? existing.assignee : (patch.assignee ?? null),
      blocked_reason:
        patch.blocked_reason === undefined ? existing.blocked_reason : (patch.blocked_reason ?? null),
      updated_at: new Date().toISOString(),
    } as Task;
    this.tasks.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    this.calls.push({ op: "delete", id });
    return this.tasks.delete(id);
  }

  async comment(id: string, content: string, author?: string): Promise<TaskComment | undefined> {
    this.calls.push({ op: "comment", id });
    if (!this.tasks.has(id)) return undefined;
    const c: TaskComment = {
      id: `${id}-c${(this.comments.get(id)?.length ?? 0) + 1}`,
      task_id: id,
      author: author ?? null,
      content,
      created_at: new Date().toISOString(),
    };
    this.comments.get(id)!.push(c);
    return c;
  }

  async query(filter?: TaskFilter): Promise<TaskQueryResult> {
    this.calls.push({ op: "query" });
    let list = [...this.tasks.values()];
    if (filter?.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      list = list.filter((t) => statuses.includes(t.status));
    }
    if (filter?.limit) list = list.slice(0, filter.limit);
    return { tasks: list, total: list.length };
  }
}

const ctx: ToolContext = {
  sessionId: "test",
  workingDirectory: "/tmp",
  env: {},
};

function build() {
  const defaultBackend = new StubBackend("default");
  const altBackend = new StubBackend("alt");
  const resolver: TaskBackendResolver = (projectId) =>
    projectId === "alt" ? altBackend : defaultBackend;
  return { defaultBackend, altBackend, resolver };
}

describe("TasksTool — per-project routing", () => {
  it("routes create to the default backend when project_id is absent", async () => {
    const { defaultBackend, altBackend, resolver } = build();
    const tool = new TasksTool(resolver);

    const r = await tool.execute({ action: "create", title: "no-project" }, ctx);
    expect(r.success).toBe(true);
    expect(defaultBackend.calls.some((c) => c.op === "create")).toBe(true);
    expect(altBackend.calls.length).toBe(0);
  });

  it("routes create to the alt backend when project_id matches", async () => {
    const { defaultBackend, altBackend, resolver } = build();
    const tool = new TasksTool(resolver);

    const r = await tool.execute(
      { action: "create", title: "alt-task", project_id: "alt" },
      ctx,
    );
    expect(r.success).toBe(true);
    expect(altBackend.calls.some((c) => c.op === "create")).toBe(true);
    expect(defaultBackend.calls.length).toBe(0);
  });

  it("routes get / update / comment / delete by project_id", async () => {
    const { defaultBackend, altBackend, resolver } = build();
    const tool = new TasksTool(resolver);

    // seed a task on alt
    const created = await altBackend.create({ title: "seeded" });
    const id = created.id;

    const got = await tool.execute({ action: "get", id, project_id: "alt" }, ctx);
    expect(got.success).toBe(true);
    expect(got.output).toContain("seeded");

    const updated = await tool.execute(
      {
        action: "update",
        id,
        status: "in_progress",
        comment: "starting",
        project_id: "alt",
      },
      ctx,
    );
    expect(updated.success).toBe(true);

    const commented = await tool.execute(
      { action: "comment", id, text: "another note", project_id: "alt" },
      ctx,
    );
    expect(commented.success).toBe(true);

    const deleted = await tool.execute(
      { action: "delete", id, project_id: "alt" },
      ctx,
    );
    expect(deleted.success).toBe(true);

    // All mutations landed on alt, none on default.
    const altOps = altBackend.calls.map((c) => c.op);
    expect(altOps).toContain("update");
    expect(altOps).toContain("comment");
    expect(altOps).toContain("delete");
    expect(defaultBackend.calls.length).toBe(0);
  });
});

describe("TaskQueryTool — per-project routing", () => {
  it("queries the resolved backend for the supplied project_id", async () => {
    const { defaultBackend, altBackend, resolver } = build();
    await defaultBackend.create({ title: "default-only" });
    await altBackend.create({ title: "alt-only" });

    const tool = new TaskQueryTool(resolver);

    const defResult = await tool.execute({ limit: 10 }, ctx);
    expect(defResult.success).toBe(true);
    expect(defResult.output).toContain("default-only");
    expect(defResult.output).not.toContain("alt-only");

    const altResult = await tool.execute({ project_id: "alt", limit: 10 }, ctx);
    expect(altResult.success).toBe(true);
    expect(altResult.output).toContain("alt-only");
    expect(altResult.output).not.toContain("default-only");
  });
});

describe("Backward compatibility", () => {
  it("accepts a plain TaskBackend (legacy single-backend constructor)", async () => {
    const backend = new StubBackend("default");
    const tool = new TasksTool(backend);

    const r = await tool.execute({ action: "create", title: "legacy" }, ctx);
    expect(r.success).toBe(true);
    expect(backend.calls.some((c) => c.op === "create")).toBe(true);
  });
});
