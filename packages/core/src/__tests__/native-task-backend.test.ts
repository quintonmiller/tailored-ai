import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db/schema.js";
import { NativeTaskBackend } from "../tasks/native.js";

let db: Database.Database;
let backend: NativeTaskBackend;

beforeEach(() => {
  db = initDatabase(":memory:");
  backend = new NativeTaskBackend(db);
});

afterEach(() => {
  db.close();
});

describe("NativeTaskBackend status map", () => {
  it("exposes the SQLite enum", () => {
    expect(backend.statuses).toEqual({
      backlog: "backlog",
      inProgress: "in_progress",
      blocked: "blocked",
      done: "done",
    });
  });

  it("recognises done and archived as terminal", () => {
    expect(backend.isDone("done")).toBe(true);
    expect(backend.isDone("archived")).toBe(true);
    expect(backend.isDone("in_progress")).toBe(false);
    expect(backend.isDone("backlog")).toBe(false);
  });
});

describe("NativeTaskBackend CRUD", () => {
  it("create + get round-trips a task with comments populated", async () => {
    const created = await backend.create({ title: "T1", description: "d", tags: ["a"] });
    expect(created.id).toMatch(/^ptask_/);
    expect(created.tags).toEqual(["a"]);

    const fetched = await backend.get(created.id);
    expect(fetched).toBeDefined();
    expect(fetched?.title).toBe("T1");
    expect(fetched?.comments).toEqual([]);
  });

  it("update applies a patch", async () => {
    const created = await backend.create({ title: "T1" });
    const updated = await backend.update(created.id, { title: "T1!", status: "in_review" });
    expect(updated?.title).toBe("T1!");
    expect(updated?.status).toBe("in_review");
  });

  it("delete returns true on success and false on missing id", async () => {
    const created = await backend.create({ title: "T1" });
    expect(await backend.delete(created.id)).toBe(true);
    expect(await backend.delete(created.id)).toBe(false);
  });

  it("comment appends a comment and surfaces it in get()", async () => {
    const created = await backend.create({ title: "T1" });
    const c = await backend.comment(created.id, "hello", "alice");
    expect(c?.author).toBe("alice");
    expect(c?.content).toBe("hello");

    const fetched = await backend.get(created.id);
    expect(fetched?.comments?.length).toBe(1);
    expect(fetched?.comments?.[0].content).toBe("hello");
  });

  it("query filters by status and search", async () => {
    await backend.create({ title: "Buy milk" });
    await backend.create({ title: "Buy bread", status: "done" });
    await backend.create({ title: "Walk dog" });

    const buys = await backend.query({ search: "Buy" });
    expect(buys.total).toBe(2);

    const done = await backend.query({ status: "done" });
    expect(done.total).toBe(1);
    expect(done.tasks[0].title).toBe("Buy bread");
  });
});

describe("NativeTaskBackend autopilot helpers", () => {
  it("nextBacklogTask picks the highest-priority backlog task for assignees", async () => {
    const a = await backend.create({ title: "A", assignee: "researcher", rank: 5 });
    await backend.create({ title: "B", assignee: "researcher", rank: 10 });
    await backend.create({ title: "C", assignee: "other", rank: 1 });

    const next = await backend.nextBacklogTask(["researcher"]);
    expect(next?.id).toBe(a.id); // lowest rank wins
  });

  it("nextBacklogTask returns undefined when no matching task exists", async () => {
    expect(await backend.nextBacklogTask(["nobody"])).toBeUndefined();
  });

  it("claimBacklog atomically transitions backlog → in_progress", async () => {
    const t = await backend.create({ title: "T", assignee: "a" });
    const claimed = await backend.claimBacklog(t.id);
    expect(claimed?.status).toBe("in_progress");

    // Second claim is a no-op.
    expect(await backend.claimBacklog(t.id)).toBeUndefined();
  });

  it("unblockBudgetTasks moves only budget-blocked tasks back to backlog", async () => {
    const a = await backend.create({ title: "A" });
    await backend.update(a.id, { status: "blocked", blocked_reason: "budget" });

    const b = await backend.create({ title: "B" });
    await backend.update(b.id, { status: "blocked", blocked_reason: "manual" });

    const restored = await backend.unblockBudgetTasks();
    expect(restored).toBe(1);
    expect((await backend.get(a.id))?.status).toBe("backlog");
    expect((await backend.get(b.id))?.status).toBe("blocked");
  });
});
