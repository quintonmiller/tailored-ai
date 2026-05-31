import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db/schema.js";
import { NativeTaskBackend } from "../tasks/native.js";
import { TaskQueryTool } from "../tools/tasks.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("TaskQueryTool description", () => {
  it("description contains the word example", () => {
    const tool = new TaskQueryTool(new NativeTaskBackend(db));
    expect(tool.description.toLowerCase()).toContain("example");
  });

  it("description contains task_query(", () => {
    const tool = new TaskQueryTool(new NativeTaskBackend(db));
    expect(tool.description).toContain("task_query(");
  });
});
