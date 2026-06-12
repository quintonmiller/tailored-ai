/**
 * Black-box smoke tests for the structured Discord-DM envelope and the
 * "suppress in-flight handoff" filter introduced in the follow-up to
 * Phase 6. We mock just enough of AgentRuntime to exercise the watcher's
 * delivery-side logic — full runtime construction pulls in providers /
 * resources / migrations we don't care about here.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db/schema.js";
import { createProjectTask, getProjectTask, updateProjectTask } from "../db/task-queries.js";
import { TypedEventBus } from "../events.js";
import { CoderProjectGuard } from "../plugins/coder-project-guard.js";
import { detectStall, TaskWatcher } from "../task-watcher.js";

let db: Database.Database;

function makeFakeRuntime(): any {
  return {
    db,
    events: new TypedEventBus(),
    getConfig: () => ({
      agents: { coder: { description: "" }, reviewer: { description: "" } },
      channels: { discord: { owner: "1234" } },
      taskWatcher: { enabled: true, delivery: { channel: "log" } },
    }),
  };
}

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

// Delivery filter (shouldSuppressDelivery) and envelope (buildNotification)
// tests moved to agent-notifier.test.ts in Slice 3 of the platform vision.
// The watcher emits agent.completed; the AgentNotifier owns delivery.

describe("detectStall", () => {
  it("returns the reason for max-rounds termination", () => {
    expect(detectStall("[Agent stopped: max tool rounds reached]")).toBe("max tool rounds reached");
  });

  it("returns the reason for repeated-call termination", () => {
    expect(detectStall("[Agent stopped: repeated identical tool calls detected]")).toBe(
      "repeated identical tool calls detected",
    );
  });

  it("returns null for a clean Sleep terminator", () => {
    expect(detectStall("[Sleep] no actionable work this tick")).toBeNull();
  });

  it("returns null for a regular textual response", () => {
    expect(detectStall("All done. Branch pushed at abc1234.")).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(detectStall("")).toBeNull();
  });

  it("tolerates leading whitespace/newlines", () => {
    expect(detectStall("\n  [Agent stopped: shutdown requested]")).toBe("shutdown requested");
  });
});

// formatStallComment + handleStall tests moved to stall-guard.test.ts in
// Slice 3 step 3 of the platform vision. Stall handling now lives in the
// StallGuard plugin that subscribes to `agent.stalled`.

describe("task-watcher coding-agent dispatch guard rail", () => {
  // The pre-flight guard (added after the main-pollution incident) refuses
  // to dispatch coder/reviewer when the task has no project_id, or when
  // the project exists but has no `path`. Either case would cause the
  // coder to run unisolated in the main checkout and commit straight
  // to main, so we mark the task blocked instead.
  it("blocks the task when coder is dispatched without a project_id", async () => {
    const dbForTest = db;
    const runtime: any = {
      db: dbForTest,
      events: new TypedEventBus(),
      contextDir: "/tmp/ctx",
      getConfig: () => ({
        agents: { coder: { description: "", worktree: true } },
        channels: { discord: { owner: "1234" } },
        taskWatcher: {
          enabled: true,
          delivery: { channel: "log" },
          triggers: ["updated"],
          debounceMs: 0,
          prompt: "",
        },
        prompts: {},
      }),
      getTools: () => [],
      getAgentDefinition: (name: string) => (name === "coder" ? { description: "", worktree: true } : undefined),
      // #204: the guard keys off worktree-opted agents, not the name "coder".
      getWorktreeAgentNames: () => ["coder"],
      resolveHooks: () => ({ beforeRun: [], afterRun: [] }),
      buildLoopOptions: () => ({}),
    };
    // Bypass the full processEvent pipeline by calling the guard rail
    // through the public notify→enqueue path is too involved; instead we
    // verify the underlying invariant: a coder task lacking project_id
    // routed through the watcher gets transitioned to blocked.
    const task = createProjectTask(dbForTest, { title: "no-proj", assignee: "coder" });
    updateProjectTask(dbForTest, task.id, { project_id: null });
    const watcher = new TaskWatcher({ runtime });
    // The guard moved to a default plugin in Slice 3 step 4. Constructing
    // it here keeps this regression test exercising the same invariant.
    new CoderProjectGuard({ runtime });
    const event = {
      action: "updated" as const,
      task: { ...task, project_id: null, tags: [] as string[] },
    };
    await (watcher as any).processEvent(event);
    const after = getProjectTask(dbForTest, task.id);
    expect(after?.status).toBe("blocked");
    expect(after?.blocked_reason).toContain("no project_id");
    const comments = dbForTest.prepare("SELECT author, content FROM task_comments WHERE task_id = ?").all(task.id) as {
      author: string;
      content: string;
    }[];
    expect(comments.some((c) => c.author === "task-watcher" && c.content.startsWith("BLOCKED:"))).toBe(true);
  });

  it("blocks the task when the project exists but has no path", async () => {
    const dbForTest = db;
    // Insert a project row with empty path.
    dbForTest
      .prepare(
        "INSERT INTO projects (id, title, path, status, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))",
      )
      .run("proj_test_nopath", "NoPath", "", "active");
    const task = createProjectTask(dbForTest, {
      title: "needs path",
      assignee: "coder",
      project_id: "proj_test_nopath",
    });
    const runtime: any = {
      db: dbForTest,
      events: new TypedEventBus(),
      contextDir: "/tmp/ctx",
      getConfig: () => ({
        agents: { coder: { description: "", worktree: true } },
        channels: { discord: { owner: "1234" } },
        taskWatcher: {
          enabled: true,
          delivery: { channel: "log" },
          triggers: ["updated"],
          debounceMs: 0,
          prompt: "",
        },
        prompts: {},
      }),
      getTools: () => [],
      getAgentDefinition: (name: string) => (name === "coder" ? { description: "", worktree: true } : undefined),
      getWorktreeAgentNames: () => ["coder"],
      resolveHooks: () => ({ beforeRun: [], afterRun: [] }),
      buildLoopOptions: () => ({}),
    };
    const watcher = new TaskWatcher({ runtime });
    new CoderProjectGuard({ runtime });
    await (watcher as any).processEvent({ action: "updated", task });
    const after = getProjectTask(dbForTest, task.id);
    expect(after?.status).toBe("blocked");
    expect(after?.blocked_reason).toContain("no path");
  });
});

describe("task-watcher notify() force flag", () => {
  it("bypasses the lastFiredAssignee gate when force=true", () => {
    const runtime: any = {
      db,
      events: new TypedEventBus(),
      getConfig: () => ({
        agents: { coder: { description: "" } },
        channels: { discord: { owner: "1234" } },
        taskWatcher: {
          enabled: true,
          delivery: { channel: "log" },
          triggers: ["updated"],
          debounceMs: 0,
        },
      }),
    };
    const watcher = new TaskWatcher({ runtime }) as any;
    const task = createProjectTask(db, { title: "T", assignee: "coder" });
    // Pre-seed the gate as if we already fired for coder.
    watcher.lastFiredAssignee.set(task.id, "coder");
    let enqueued = 0;
    watcher.enqueue = () => {
      enqueued++;
    };

    // Non-force: gate blocks (same assignee).
    watcher.notify({ action: "updated", task });
    // Force: gate is bypassed.
    watcher.notify({ action: "updated", task }, { force: true });

    // Allow debounce timer to flush.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(enqueued).toBe(1);
        resolve();
      }, 20);
    });
  });
});

describe("task-watcher notifyById per-project routing", () => {
  // Regression: when a task lives on a per-project backend (e.g. the
  // GitHub task backend per PR #123), notifyById's old SQL lookup against
  // `project_tasks` couldn't find it. Tasks like `gh-3` silently
  // disappeared from the routing pipeline — coder never ran. With a
  // projectId argument, the watcher routes through
  // runtime.getTaskBackendForProject(...).get(id).
  it("routes notifyById to the project's backend when projectId is supplied", async () => {
    // In-memory stub backend that knows about a single task.
    const stubBackend = {
      name: "stub",
      get: async (id: string) => {
        if (id !== "gh-3") return undefined;
        return {
          id: "gh-3",
          title: "Add hello_tai.py",
          description: "",
          status: "backlog",
          author: "agent",
          tags: [],
          assignee: "coder",
          rank: 3,
          blocked_reason: null,
          project_id: null,
          created_at: "2026-06-03T00:00:00Z",
          updated_at: "2026-06-03T00:00:00Z",
        };
      },
    };
    const runtime: any = {
      db,
      events: new TypedEventBus(),
      getConfig: () => ({
        agents: { coder: { description: "" } },
        channels: {},
        taskWatcher: { enabled: true, delivery: { channel: "log" }, triggers: ["created"], debounceMs: 0 },
      }),
      getTaskBackendForProject: (projectId: string | undefined) => {
        expect(projectId).toBe("tai-personal");
        return stubBackend;
      },
    };
    const watcher = new TaskWatcher({ runtime }) as any;
    const received: Array<{ action: string; taskId: string; projectId: string | null }> = [];
    watcher.notify = (event: { action: string; task: { id: string; project_id: string | null } }) => {
      received.push({ action: event.action, taskId: event.task.id, projectId: event.task.project_id });
    };

    watcher.notifyById("created", "gh-3", "tai-personal");

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(received).toEqual([{ action: "created", taskId: "gh-3", projectId: "tai-personal" }]);
        resolve();
      }, 30);
    });
  });

  it("falls back to the native SQL path when no projectId is supplied", () => {
    const runtime = makeFakeRuntime();
    const watcher = new TaskWatcher({ runtime }) as any;
    const task = createProjectTask(db, { title: "Local task", assignee: "coder" });
    const received: Array<{ action: string; taskId: string }> = [];
    watcher.notify = (event: { action: string; task: { id: string } }) => {
      received.push({ action: event.action, taskId: event.task.id });
    };

    watcher.notifyById("created", task.id);

    expect(received).toEqual([{ action: "created", taskId: task.id }]);
  });

  it("no-ops silently when the per-project backend returns undefined", async () => {
    const stubBackend = { name: "stub", get: async () => undefined };
    const runtime: any = {
      db,
      events: new TypedEventBus(),
      getConfig: () => ({
        agents: {},
        channels: {},
        taskWatcher: { enabled: true, delivery: { channel: "log" }, triggers: ["created"], debounceMs: 0 },
      }),
      getTaskBackendForProject: () => stubBackend,
    };
    const watcher = new TaskWatcher({ runtime }) as any;
    let notifyCalls = 0;
    watcher.notify = () => {
      notifyCalls++;
    };

    watcher.notifyById("created", "gh-9999", "tai-personal");

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(notifyCalls).toBe(0);
        resolve();
      }, 30);
    });
  });
});
