import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDatabase } from "../db/schema.js";
import { addTaskComment, createProjectTask, getProjectTask, updateProjectTask } from "../db/task-queries.js";
import { TypedEventBus } from "../events.js";
import { VerifyGate } from "../plugins/verify-gate.js";
import type { AgentRuntime } from "../runtime.js";

let db: Database.Database;

function makeRuntime(): AgentRuntime {
  const events = new TypedEventBus();
  return {
    db,
    events,
    getConfig: () => ({ agents: { reviewer: { description: "" }, coder: { description: "" } } }),
    getTaskBackend: () => ({ statuses: { done: "done" } }),
  } as unknown as AgentRuntime;
}

function makeTask(opts: { tags?: string[]; assignee?: string } = {}): string {
  const t = createProjectTask(db, {
    title: "Add reading widget",
    description: "## Acceptance\nverify: curl /api/dashboard | grep reading",
    tags: opts.tags ?? [],
    assignee: opts.assignee ?? "coder",
  });
  return t.id;
}

function emitDone(runtime: AgentRuntime, taskId: string): void {
  // Simulate the implementer/worker actually setting the task done, then
  // announcing it — the gate reacts to the announcement.
  updateProjectTask(runtime.db, taskId, { status: "done" });
  runtime.events.emit("task.transitioned", {
    taskId,
    projectId: undefined,
    from: "in_progress",
    to: "done",
    assignee: "coder",
  });
}

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("VerifyGate", () => {
  it("bounces an unverified done back to the reviewer and asks the watcher to re-dispatch", () => {
    const runtime = makeRuntime();
    new VerifyGate({ runtime });
    const dispatch = vi.fn();
    runtime.events.on("task.dispatch_requested", dispatch);

    const id = makeTask();
    emitDone(runtime, id);

    const task = getProjectTask(db, id);
    expect(task?.status).toBe("in_review");
    expect(task?.assignee).toBe("reviewer");
    expect(task?.comments.some((c) => c.content.includes("VERIFY GATE:"))).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("lets a done stand when the latest verdict is VERIFY: PASS", () => {
    const runtime = makeRuntime();
    new VerifyGate({ runtime });
    const dispatch = vi.fn();
    runtime.events.on("task.dispatch_requested", dispatch);

    const id = makeTask();
    addTaskComment(db, id, {
      author: "reviewer",
      content: "Ran the check. VERIFY: PASS — widget resolves at /api/dashboard.",
    });
    emitDone(runtime, id);

    const task = getProjectTask(db, id);
    expect(task?.status).toBe("done");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("bounces when the most recent verdict is FAIL even if an older PASS exists", () => {
    const runtime = makeRuntime();
    new VerifyGate({ runtime });

    const id = makeTask();
    addTaskComment(db, id, { author: "reviewer", content: "VERIFY: PASS" });
    addTaskComment(db, id, { author: "reviewer", content: "Re-checked after edit. VERIFY: FAIL — endpoint 404s." });
    emitDone(runtime, id);

    expect(getProjectTask(db, id)?.status).toBe("in_review");
  });

  it("only gates tasks bearing a required tag when requireTags is set", () => {
    const runtime = makeRuntime();
    new VerifyGate({ runtime, requireTags: ["kind:code", "kind:config"] });

    const pa = makeTask({ tags: ["pa"] }); // not gated
    emitDone(runtime, pa);
    expect(getProjectTask(db, pa)?.status).toBe("done");

    const code = makeTask({ tags: ["kind:code"] }); // gated
    emitDone(runtime, code);
    expect(getProjectTask(db, code)?.status).toBe("in_review");
  });

  it("routes the bounce by tag: config → verifier, code → reviewer", () => {
    const runtime = makeRuntime();
    new VerifyGate({ runtime, reviewerByTag: { "kind:config": "verifier", "kind:code": "reviewer" } });

    const cfg = makeTask({ tags: ["kind:config"] });
    emitDone(runtime, cfg);
    expect(getProjectTask(db, cfg)?.assignee).toBe("verifier");

    const code = makeTask({ tags: ["kind:code"] });
    emitDone(runtime, code);
    expect(getProjectTask(db, code)?.assignee).toBe("reviewer");
  });

  it("escalates to a human after maxBounces instead of looping forever", () => {
    const runtime = makeRuntime();
    new VerifyGate({ runtime, maxBounces: 2 });
    const needsHuman = vi.fn();
    runtime.events.on("task.needs_human", needsHuman);

    const id = makeTask();
    emitDone(runtime, id); // bounce 1
    emitDone(runtime, id); // bounce 2
    emitDone(runtime, id); // now at cap → escalate

    expect(needsHuman).toHaveBeenCalledTimes(1);
    expect(needsHuman.mock.calls[0][0].reason).toBe("verify");
  });
});
