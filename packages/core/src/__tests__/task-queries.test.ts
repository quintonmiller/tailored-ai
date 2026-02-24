import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addTaskComment,
  createProjectTask,
  deleteProjectTask,
  getProjectTask,
  queryProjectTasks,
  updateProjectTask,
} from "../db/task-queries.js";
import { initDatabase } from "../db/schema.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("createProjectTask", () => {
  it("creates a task with defaults", () => {
    const task = createProjectTask(db, { title: "Test task" });
    expect(task.id).toMatch(/^ptask_/);
    expect(task.title).toBe("Test task");
    expect(task.description).toBe("");
    expect(task.status).toBe("backlog");
    expect(task.author).toBe("");
    expect(task.tags).toEqual([]);
    expect(task.created_at).toBeTruthy();
    expect(task.updated_at).toBeTruthy();
  });

  it("creates a task with all fields", () => {
    const task = createProjectTask(db, {
      title: "Full task",
      description: "A detailed description",
      author: "alice",
      tags: ["bug", "urgent"],
      status: "in_progress",
    });
    expect(task.title).toBe("Full task");
    expect(task.description).toBe("A detailed description");
    expect(task.author).toBe("alice");
    expect(task.tags).toEqual(["bug", "urgent"]);
    expect(task.status).toBe("in_progress");
  });

  it("rejects invalid status", () => {
    expect(() => createProjectTask(db, { title: "Bad", status: "invalid" })).toThrow();
  });
});

describe("getProjectTask", () => {
  it("returns task with comments", () => {
    const task = createProjectTask(db, { title: "Get me" });
    addTaskComment(db, task.id, { content: "First comment", author: "bob" });
    addTaskComment(db, task.id, { content: "Second comment" });

    const fetched = getProjectTask(db, task.id);
    expect(fetched).toBeDefined();
    expect(fetched!.title).toBe("Get me");
    expect(fetched!.comments).toHaveLength(2);
    expect(fetched!.comments[0].content).toBe("First comment");
    expect(fetched!.comments[0].author).toBe("bob");
    expect(fetched!.comments[1].content).toBe("Second comment");
  });

  it("returns undefined for missing task", () => {
    expect(getProjectTask(db, "ptask_nonexist")).toBeUndefined();
  });
});

describe("updateProjectTask", () => {
  it("updates individual fields", () => {
    const task = createProjectTask(db, { title: "Original" });

    const updated = updateProjectTask(db, task.id, { title: "Updated" });
    expect(updated!.title).toBe("Updated");

    const updated2 = updateProjectTask(db, task.id, { status: "done", author: "charlie" });
    expect(updated2!.status).toBe("done");
    expect(updated2!.author).toBe("charlie");
  });

  it("updates tags", () => {
    const task = createProjectTask(db, { title: "Tagged", tags: ["a"] });
    const updated = updateProjectTask(db, task.id, { tags: ["b", "c"] });
    expect(updated!.tags).toEqual(["b", "c"]);
  });

  it("returns undefined for missing task", () => {
    expect(updateProjectTask(db, "ptask_missing", { title: "X" })).toBeUndefined();
  });

  it("rejects invalid status on update", () => {
    const task = createProjectTask(db, { title: "Valid" });
    expect(() => updateProjectTask(db, task.id, { status: "bad_status" })).toThrow();
  });

  it("touches updated_at", () => {
    const task = createProjectTask(db, { title: "Timestamp test" });
    const before = task.updated_at;
    // SQLite datetime precision is 1 second, so we verify it doesn't go backwards
    const updated = updateProjectTask(db, task.id, { title: "Changed" });
    expect(updated!.updated_at).toBeTruthy();
    expect(updated!.updated_at >= before).toBe(true);
  });
});

describe("deleteProjectTask", () => {
  it("deletes task and cascades comments", () => {
    const task = createProjectTask(db, { title: "Delete me" });
    addTaskComment(db, task.id, { content: "Will be gone" });

    expect(deleteProjectTask(db, task.id)).toBe(true);
    expect(getProjectTask(db, task.id)).toBeUndefined();

    // Comments should be gone too
    const comments = db.prepare("SELECT * FROM task_comments WHERE task_id = ?").all(task.id);
    expect(comments).toHaveLength(0);
  });

  it("returns false for missing task", () => {
    expect(deleteProjectTask(db, "ptask_nope")).toBe(false);
  });
});

describe("addTaskComment", () => {
  it("adds a comment and returns it", () => {
    const task = createProjectTask(db, { title: "Commentable" });
    const comment = addTaskComment(db, task.id, { content: "Hello", author: "dave" });

    expect(comment).toBeDefined();
    expect(comment!.content).toBe("Hello");
    expect(comment!.author).toBe("dave");
    expect(comment!.task_id).toBe(task.id);
    expect(comment!.created_at).toBeTruthy();
  });

  it("returns undefined for missing task", () => {
    expect(addTaskComment(db, "ptask_missing", { content: "No task" })).toBeUndefined();
  });

  it("touches parent updated_at", () => {
    const task = createProjectTask(db, { title: "Comment touch" });
    const before = task.updated_at;
    addTaskComment(db, task.id, { content: "Touch" });
    const after = getProjectTask(db, task.id);
    expect(after!.updated_at >= before).toBe(true);
  });
});

describe("queryProjectTasks", () => {
  it("returns all tasks with no filter", () => {
    createProjectTask(db, { title: "A" });
    createProjectTask(db, { title: "B" });
    createProjectTask(db, { title: "C" });

    const result = queryProjectTasks(db);
    expect(result.total).toBe(3);
    expect(result.tasks).toHaveLength(3);
  });

  it("filters by status (single)", () => {
    createProjectTask(db, { title: "Backlog", status: "backlog" });
    createProjectTask(db, { title: "Done", status: "done" });

    const result = queryProjectTasks(db, { status: "done" });
    expect(result.total).toBe(1);
    expect(result.tasks[0].title).toBe("Done");
  });

  it("filters by status (multiple)", () => {
    createProjectTask(db, { title: "Backlog", status: "backlog" });
    createProjectTask(db, { title: "In Progress", status: "in_progress" });
    createProjectTask(db, { title: "Done", status: "done" });

    const result = queryProjectTasks(db, { status: ["backlog", "in_progress"] });
    expect(result.total).toBe(2);
  });

  it("filters by author", () => {
    createProjectTask(db, { title: "Alice task", author: "alice" });
    createProjectTask(db, { title: "Bob task", author: "bob" });

    const result = queryProjectTasks(db, { author: "alice" });
    expect(result.total).toBe(1);
    expect(result.tasks[0].author).toBe("alice");
  });

  it("filters by tags (any match)", () => {
    createProjectTask(db, { title: "Bug", tags: ["bug", "urgent"] });
    createProjectTask(db, { title: "Feature", tags: ["feature"] });
    createProjectTask(db, { title: "Both", tags: ["bug", "feature"] });

    const result = queryProjectTasks(db, { tags: ["bug"] });
    expect(result.total).toBe(2);
  });

  it("searches title and description", () => {
    createProjectTask(db, { title: "Fix login", description: "Login page broken" });
    createProjectTask(db, { title: "Add dashboard", description: "New dashboard page" });

    const result = queryProjectTasks(db, { search: "login" });
    expect(result.total).toBe(1);
    expect(result.tasks[0].title).toBe("Fix login");
  });

  it("paginates with limit and offset", () => {
    for (let i = 0; i < 10; i++) {
      createProjectTask(db, { title: `Task ${i}` });
    }

    const page1 = queryProjectTasks(db, { limit: 3, offset: 0 });
    expect(page1.tasks).toHaveLength(3);
    expect(page1.total).toBe(10);

    const page2 = queryProjectTasks(db, { limit: 3, offset: 3 });
    expect(page2.tasks).toHaveLength(3);
    expect(page2.total).toBe(10);

    // No overlap
    const ids1 = page1.tasks.map((t) => t.id);
    const ids2 = page2.tasks.map((t) => t.id);
    expect(ids1.some((id) => ids2.includes(id))).toBe(false);
  });

  it("combines multiple filters", () => {
    createProjectTask(db, { title: "Match", status: "in_progress", author: "alice", tags: ["bug"] });
    createProjectTask(db, { title: "Wrong status", status: "done", author: "alice", tags: ["bug"] });
    createProjectTask(db, { title: "Wrong author", status: "in_progress", author: "bob", tags: ["bug"] });

    const result = queryProjectTasks(db, { status: "in_progress", author: "alice", tags: ["bug"] });
    expect(result.total).toBe(1);
    expect(result.tasks[0].title).toBe("Match");
  });
});
