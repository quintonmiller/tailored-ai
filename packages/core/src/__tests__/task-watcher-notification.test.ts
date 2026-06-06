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
import { addTaskComment, createProjectTask, getProjectTask, updateProjectTask } from "../db/task-queries.js";
import { detectStall, formatStallComment, TaskWatcher } from "../task-watcher.js";

let db: Database.Database;

function makeFakeRuntime(): any {
  return {
    db,
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

describe("task-watcher delivery filter (shouldSuppressDelivery)", () => {
  it("suppresses delivery when assignee is a known agent and status is in-flight", () => {
    const runtime = makeFakeRuntime();
    const watcher = new TaskWatcher({ runtime });
    expect((watcher as any).shouldSuppressDelivery("coder", "in_progress")).toBe(true);
    expect((watcher as any).shouldSuppressDelivery("reviewer", "in_review")).toBe(true);
  });

  it("delivers when assignee is a person (not a defined agent)", () => {
    const runtime = makeFakeRuntime();
    const watcher = new TaskWatcher({ runtime });
    expect((watcher as any).shouldSuppressDelivery("Quinton", "in_review")).toBe(false);
    expect((watcher as any).shouldSuppressDelivery("107389829628612608", "in_review")).toBe(false);
  });

  it("always delivers terminal/blocked statuses regardless of assignee", () => {
    const runtime = makeFakeRuntime();
    const watcher = new TaskWatcher({ runtime });
    expect((watcher as any).shouldSuppressDelivery("coder", "blocked")).toBe(false);
    expect((watcher as any).shouldSuppressDelivery("coder", "done")).toBe(false);
    expect((watcher as any).shouldSuppressDelivery(null, "done")).toBe(false);
  });

  it("delivers when no assignee at all (triage ping)", () => {
    const runtime = makeFakeRuntime();
    const watcher = new TaskWatcher({ runtime });
    expect((watcher as any).shouldSuppressDelivery(null, "backlog")).toBe(false);
  });
});

describe("task-watcher envelope (buildNotification)", () => {
  it("renders task id, title, status, assignee in the header", async () => {
    const runtime = makeFakeRuntime();
    const watcher = new TaskWatcher({ runtime });
    const task = createProjectTask(db, { title: "Add foo support" });
    updateProjectTask(db, task.id, { status: "in_review", assignee: "Quinton" });
    const final = { id: task.id, title: "Add foo support", status: "in_review" };
    const msg = await (watcher as any).buildNotification(
      { action: "updated", task },
      final,
      "Quinton",
      "in_review",
      "",
    );
    expect(msg).toContain(task.id);
    expect(msg).toContain("Add foo support");
    expect(msg).toContain("status: in_review");
    expect(msg).toContain("assignee: Quinton");
  });

  it("surfaces the latest task comment as a blockquote", async () => {
    const runtime = makeFakeRuntime();
    const watcher = new TaskWatcher({ runtime });
    const task = createProjectTask(db, { title: "T" });
    addTaskComment(db, task.id, { author: "reviewer", content: "APPROVED — looks great" });
    const final = { id: task.id, title: "T", status: "in_review" };
    const msg = await (watcher as any).buildNotification(
      { action: "updated", task },
      final,
      "Quinton",
      "in_review",
      "",
    );
    expect(msg).toContain("> *reviewer*:");
    expect(msg).toContain("APPROVED — looks great");
  });

  it("includes merge commands when latest comment references a branch", async () => {
    const runtime = makeFakeRuntime();
    const watcher = new TaskWatcher({ runtime });
    const task = createProjectTask(db, { title: "T" });
    addTaskComment(db, task.id, {
      author: "coder",
      content: "Branch: agent/feature-x. Commit: abc1234. Summary: did the thing.",
    });
    const final = { id: task.id, title: "T", status: "in_review" };
    const msg = await (watcher as any).buildNotification(
      { action: "updated", task },
      final,
      "Quinton",
      "in_review",
      "",
    );
    expect(msg).toContain("ready for your review");
    expect(msg).toContain("git diff main..agent/feature-x");
    expect(msg).toContain("git merge --ff-only agent/feature-x");
  });

  it("emojis match the status (in_review with human assignee = 🔍, blocked = 🚫, done = ✅)", async () => {
    const runtime = makeFakeRuntime();
    const watcher = new TaskWatcher({ runtime });
    const task = createProjectTask(db, { title: "T" });
    const final = { id: task.id, title: "T", status: "done" };
    const done = await (watcher as any).buildNotification({ action: "updated", task }, final, null, "done", "");
    expect(done).toContain("✅");
    const blocked = await (watcher as any).buildNotification(
      { action: "updated", task },
      { ...final, status: "blocked" },
      null,
      "blocked",
      "",
    );
    expect(blocked).toContain("🚫");
  });

  it("does not duplicate agent response when it overlaps with latest comment", async () => {
    const runtime = makeFakeRuntime();
    const watcher = new TaskWatcher({ runtime });
    const task = createProjectTask(db, { title: "T" });
    addTaskComment(db, task.id, {
      author: "reviewer",
      content: "Long detailed approved review with many points and so on...",
    });
    const final = { id: task.id, title: "T", status: "in_review" };
    const msg = await (watcher as any).buildNotification(
      { action: "updated", task },
      final,
      "Quinton",
      "in_review",
      "Long detailed approved review with many points and so on... extra trailing text",
    );
    // The agent response should NOT appear in full because it overlaps the comment.
    const occurrences = (msg.match(/Long detailed approved review/g) ?? []).length;
    expect(occurrences).toBe(1);
  });
});

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

describe("formatStallComment", () => {
  it("starts with the STALL #N prefix so subsequent stalls can count priors", () => {
    expect(formatStallComment(1, "max tool rounds reached", null, null)).toMatch(/^STALL #1: /);
    expect(formatStallComment(3, "x", null, null)).toMatch(/^STALL #3: /);
  });

  it("includes the worktree path and diff stat when provided", () => {
    const c = formatStallComment(1, "max tool rounds reached", "/tmp/wt/agent/abc", {
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

describe("task-watcher stall handling (handleStall)", () => {
  function makeWatcher() {
    const runtime: any = {
      db,
      getConfig: () => ({
        agents: { coder: { description: "" } },
        channels: { discord: { owner: "1234" } },
        taskWatcher: { enabled: true, delivery: { channel: "log" }, maxStallRetries: 1 },
      }),
    };
    return new TaskWatcher({ runtime });
  }

  it("writes a STALL #1 comment and retries on first stall", async () => {
    const watcher = makeWatcher() as any;
    const task = createProjectTask(db, { title: "T", assignee: "coder" });
    const result = await watcher.handleStall({
      event: { action: "updated", task },
      stallReason: "max tool rounds reached",
      worktreePath: null,
      logPrefix: "[test]",
    });
    expect(result.retried).toBe(true);
    const after = getProjectTask(db, task.id);
    expect(after?.status).toBe("backlog");
    const comments = db
      .prepare("SELECT author, content FROM task_comments WHERE task_id = ? ORDER BY id")
      .all(task.id) as { author: string; content: string }[];
    expect(comments).toHaveLength(1);
    expect(comments[0].author).toBe("task-watcher");
    expect(comments[0].content).toMatch(/^STALL #1: max tool rounds reached/);
  });

  it("transitions to blocked on the second stall (default maxStallRetries=1)", async () => {
    const watcher = makeWatcher() as any;
    const task = createProjectTask(db, { title: "T", assignee: "coder" });
    addTaskComment(db, task.id, {
      author: "task-watcher",
      content: "STALL #1: max tool rounds reached\nWorktree preserved at: /tmp/wt",
    });
    const result = await watcher.handleStall({
      event: { action: "updated", task },
      stallReason: "repeated identical tool calls detected",
      worktreePath: null,
      logPrefix: "[test]",
    });
    expect(result.retried).toBe(false);
    const after = getProjectTask(db, task.id);
    expect(after?.status).toBe("blocked");
    expect(after?.blocked_reason).toMatch(/coder-stalled after 2 attempts/);
    const comments = db.prepare("SELECT content FROM task_comments WHERE task_id = ? ORDER BY id").all(task.id) as {
      content: string;
    }[];
    // Three comments: pre-existing STALL #1, the new STALL #2, and the
    // decomposition hint emitted when out of retries.
    expect(comments).toHaveLength(3);
    expect(comments[1].content).toMatch(/^STALL #2: repeated identical/);
    expect(comments[2].content).toMatch(/Two stalls in a row/);
  });

  it("respects maxStallRetries > 1 from config", async () => {
    const runtime: any = {
      db,
      getConfig: () => ({
        agents: { coder: { description: "" } },
        channels: { discord: { owner: "1234" } },
        taskWatcher: { enabled: true, delivery: { channel: "log" }, maxStallRetries: 2 },
      }),
    };
    const watcher = new TaskWatcher({ runtime }) as any;
    const task = createProjectTask(db, { title: "T", assignee: "coder" });
    addTaskComment(db, task.id, { author: "task-watcher", content: "STALL #1: x" });
    const result = await watcher.handleStall({
      event: { action: "updated", task },
      stallReason: "x",
      worktreePath: null,
      logPrefix: "[test]",
    });
    expect(result.retried).toBe(true);
    const after = getProjectTask(db, task.id);
    expect(after?.status).toBe("backlog");
  });
});

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
      contextDir: "/tmp/ctx",
      getConfig: () => ({
        agents: { coder: { description: "" } },
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
    // Hand-build the event the watcher would receive.
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
      contextDir: "/tmp/ctx",
      getConfig: () => ({
        agents: { coder: { description: "" } },
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
      resolveHooks: () => ({ beforeRun: [], afterRun: [] }),
      buildLoopOptions: () => ({}),
    };
    const watcher = new TaskWatcher({ runtime });
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
