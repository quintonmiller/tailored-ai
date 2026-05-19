/**
 * Black-box smoke tests for the structured Discord-DM envelope and the
 * "suppress in-flight handoff" filter introduced in the follow-up to
 * Phase 6. We mock just enough of AgentRuntime to exercise the watcher's
 * delivery-side logic — full runtime construction pulls in providers /
 * resources / migrations we don't care about here.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addTaskComment, createProjectTask, updateProjectTask } from "../db/task-queries.js";
import { initDatabase } from "../db/schema.js";
import { TaskWatcher } from "../task-watcher.js";

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
    const done = await (watcher as any).buildNotification(
      { action: "updated", task },
      final,
      null,
      "done",
      "",
    );
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
    addTaskComment(db, task.id, { author: "reviewer", content: "Long detailed approved review with many points and so on..." });
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
