import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db/schema.js";
import { NativeTaskBackend } from "../tasks/native.js";
import type { ToolContext } from "../tools/interface.js";
import { TasksTool } from "../tools/tasks.js";

let db: Database.Database;
const ctx: ToolContext = {
  sessionId: "test",
  workingDirectory: "/tmp",
  env: {},
};

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("TasksTool unknown action error", () => {
  it("includes valid actions list in the error message", async () => {
    const tool = new TasksTool(new NativeTaskBackend(db), db);
    const result = await tool.execute({ action: "list" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown action");
    expect(result.error).toContain("Valid actions:");
    expect(result.error).toContain("create");
  });
});
