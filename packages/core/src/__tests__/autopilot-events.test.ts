/**
 * Autopilot worker event emission tests (#205). The worker no longer DMs the
 * owner inline: it emits `digest.ready` from the morning digest and
 * `task.needs_human` when a task run throws. These pin the events at the
 * right call sites without standing up a live provider.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AutopilotWorker } from "../autopilot/worker.js";
import { initDatabase } from "../db/schema.js";
import { createProjectTask } from "../db/task-queries.js";
import { type RuntimeEventPayload, TypedEventBus } from "../events.js";
import type { AgentRuntime } from "../runtime.js";
import type { Task, TaskBackend } from "../tasks/interface.js";

let db: Database.Database;

function makeRuntime(events: TypedEventBus, over: Record<string, unknown> = {}): AgentRuntime {
  return {
    db,
    events,
    getConfig: () => ({ agents: { default: { description: "" } }, ...over }),
    getTaskBackend: () => fakeBackend,
  } as unknown as AgentRuntime;
}

let fakeBackend: TaskBackend;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("AutopilotWorker digest.ready", () => {
  it("emits digest.ready with the rendered content when the digest is non-empty", async () => {
    // Seed a done task so the digest isn't empty.
    const t = createProjectTask(db, { title: "Shipped it" });
    db.prepare("UPDATE project_tasks SET status = 'done' WHERE id = ?").run(t.id);

    const events = new TypedEventBus();
    const received: RuntimeEventPayload<"digest.ready">[] = [];
    events.on("digest.ready", (e) => {
      received.push(e);
    });
    const worker = new AutopilotWorker({ runtime: makeRuntime(events), taskBackend: {} as TaskBackend });

    await worker.runDigest();

    expect(received).toHaveLength(1);
    expect(received[0].periodLabel).toBe("Morning");
    expect(received[0].content).toContain("Shipped it");
    // Digest was recorded.
    expect((db.prepare("SELECT COUNT(*) c FROM digest_runs").get() as { c: number }).c).toBe(1);
  });

  it("does not emit when the digest is empty", async () => {
    const events = new TypedEventBus();
    let fired = false;
    events.on("digest.ready", () => {
      fired = true;
    });
    const worker = new AutopilotWorker({ runtime: makeRuntime(events), taskBackend: {} as TaskBackend });

    await worker.runDigest();
    expect(fired).toBe(false);
  });
});

describe("AutopilotWorker task.needs_human", () => {
  it("emits task.needs_human when a claimed task run throws", async () => {
    const task = createProjectTask(db, { title: "Boom task", assignee: "default" });

    const events = new TypedEventBus();
    const received: RuntimeEventPayload<"task.needs_human">[] = [];
    events.on("task.needs_human", (e) => {
      received.push(e);
    });

    const comments: Array<{ id: string; content: string; author: string }> = [];
    const updates: Array<Record<string, unknown>> = [];
    fakeBackend = {
      name: "fake",
      statuses: { blocked: "blocked", inProgress: "in_progress", done: "done", inReview: "in_review" },
      nextBacklogTask: async () => task as unknown as Task,
      claimBacklog: async () => task as unknown as Task,
      unblockBudgetTasks: async () => 0,
      comment: async (id: string, content: string, author: string) => {
        comments.push({ id, content, author });
      },
      update: async (id: string, patch: Record<string, unknown>) => {
        updates.push({ id, ...patch });
      },
      // runTask calls this.tasks.get(task.id) first; throw to drive the catch.
      get: async () => {
        throw new Error("kaboom");
      },
    } as unknown as TaskBackend;

    const worker = new AutopilotWorker({
      runtime: makeRuntime(events),
      taskBackend: fakeBackend,
    });

    await worker.tick();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ taskId: task.id, reason: "error", agentName: "default" });
    expect(received[0].message).toContain("Boom task");
    expect(received[0].message).toContain("kaboom");
    // The task was also commented + blocked (unchanged behavior).
    expect(updates.some((u) => u.status === "blocked" && u.blocked_reason === "error")).toBe(true);
    expect(comments.some((c) => c.content.includes("kaboom"))).toBe(true);
  });
});
