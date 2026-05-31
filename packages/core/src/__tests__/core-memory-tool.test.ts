import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getCoreMemorySection } from "../db/core-memory-queries.js";
import { initDatabase } from "../db/schema.js";
import { CoreMemoryTool } from "../tools/core-memory.js";
import type { ToolContext } from "../tools/interface.js";

let db: Database.Database;

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: "sess_test",
    workingDirectory: "/tmp",
    env: {},
    agentName: "default",
    projectId: null,
    db,
    ...overrides,
  };
}

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("core_memory tool", () => {
  it("requires agentName in context", async () => {
    const tool = new CoreMemoryTool(db);
    const result = await tool.execute({ action: "read" }, makeContext({ agentName: undefined }));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/agentName/);
  });

  it("set writes a section and is readable", async () => {
    const tool = new CoreMemoryTool(db);
    const r1 = await tool.execute({ action: "set", section: "persona", content: "Quiet and direct." }, makeContext());
    expect(r1.success).toBe(true);
    const r2 = await tool.execute({ action: "read", section: "persona" }, makeContext());
    expect(r2.success).toBe(true);
    expect(r2.output).toBe("Quiet and direct.");
  });

  it("append adds lines to a list section", async () => {
    const tool = new CoreMemoryTool(db);
    await tool.execute(
      { action: "append", section: "active_threads", content: "Looking into iMessage backlog" },
      makeContext(),
    );
    await tool.execute(
      { action: "append", section: "active_threads", content: "Researching calendar delete API" },
      makeContext(),
    );
    const read = await tool.execute({ action: "read", section: "active_threads" }, makeContext());
    expect(read.output).toContain("iMessage backlog");
    expect(read.output).toContain("calendar delete");
  });

  it("remove drops a line by substring", async () => {
    const tool = new CoreMemoryTool(db);
    await tool.execute(
      { action: "append", section: "open_questions", content: "Q: should iMessage be a channel?" },
      makeContext(),
    );
    await tool.execute(
      { action: "append", section: "open_questions", content: "Q: storage for facts?" },
      makeContext(),
    );
    const result = await tool.execute(
      { action: "remove", section: "open_questions", match: "iMessage" },
      makeContext(),
    );
    expect(result.success).toBe(true);
    const after = await tool.execute({ action: "read", section: "open_questions" }, makeContext());
    expect(after.output).not.toContain("iMessage");
    expect(after.output).toContain("storage for facts");
  });

  it("global=true writes to the project-invariant row", async () => {
    const tool = new CoreMemoryTool(db);
    await tool.execute(
      { action: "set", section: "persona", content: "global voice", global: true },
      makeContext({ projectId: "proj_a" }),
    );
    // Direct DB check
    const row = getCoreMemorySection(db, { agent: "default", project_id: null }, "persona");
    expect(row?.content).toBe("global voice");
  });

  it("project-scoped writes don't leak to global", async () => {
    const tool = new CoreMemoryTool(db);
    await tool.execute(
      { action: "set", section: "active_threads", content: "project A specific" },
      makeContext({ projectId: "proj_a" }),
    );
    const globalRow = getCoreMemorySection(db, { agent: "default", project_id: null }, "active_threads");
    const projectRow = getCoreMemorySection(db, { agent: "default", project_id: "proj_a" }, "active_threads");
    expect(globalRow).toBeNull();
    expect(projectRow?.content).toBe("project A specific");
  });

  it("read without section returns all sections labeled", async () => {
    const tool = new CoreMemoryTool(db);
    await tool.execute({ action: "set", section: "persona", content: "p" }, makeContext());
    await tool.execute({ action: "set", section: "user_state", content: "u" }, makeContext());
    const all = await tool.execute({ action: "read" }, makeContext());
    expect(all.output).toContain("## persona");
    expect(all.output).toContain("## user_state");
  });

  it("clear removes a section completely", async () => {
    const tool = new CoreMemoryTool(db);
    await tool.execute({ action: "set", section: "user_state", content: "x" }, makeContext());
    const r = await tool.execute({ action: "clear", section: "user_state" }, makeContext());
    expect(r.success).toBe(true);
    const after = await tool.execute({ action: "read", section: "user_state" }, makeContext());
    expect(after.output).toBe("(user_state is empty)");
  });

  it("rejects unknown action", async () => {
    const tool = new CoreMemoryTool(db);
    const r = await tool.execute({ action: "blah" }, makeContext());
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Unknown action/);
  });

  it("rejects unknown section on set", async () => {
    const tool = new CoreMemoryTool(db);
    const r = await tool.execute({ action: "set", section: "not_a_section", content: "x" }, makeContext());
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/section is required/);
  });

  it("append requires content", async () => {
    const tool = new CoreMemoryTool(db);
    const r = await tool.execute({ action: "append", section: "active_threads" }, makeContext());
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/content is required/);
  });
});
