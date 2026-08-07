import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db/schema.js";
import { listTickLogs } from "../db/tick-log-queries.js";
import type { ToolContext } from "../tools/interface.js";
import { SleepTool } from "../tools/sleep.js";

let db: Database.Database;

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: "sess_test",
    workingDirectory: "/tmp",
    env: {},
    agentName: "default",
    db,
    exploratoryRunId: "xrun_test",
    projectId: null,
    ...overrides,
  };
}

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("Sleep tool", () => {
  it("writes a noop row to tick_log on success", async () => {
    const tool = new SleepTool(db);
    const result = await tool.execute({ reason: "no new emails, backlog all blocked, no stale threads" }, makeCtx());
    expect(result.success).toBe(true);
    const rows = listTickLogs(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("noop");
    expect(rows[0].summary).toContain("no new emails");
  });

  it("requires a reason", async () => {
    const tool = new SleepTool(db);
    const result = await tool.execute({}, makeCtx());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/reason is required/);
  });

  it("rejects calls outside an exploratory tick", async () => {
    const tool = new SleepTool(db);
    const result = await tool.execute({ reason: "x" }, makeCtx({ exploratoryRunId: undefined }));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/only available inside an exploratory tick/);
  });

  it("uses tick_id from context", async () => {
    const tool = new SleepTool(db);
    await tool.execute({ reason: "x" }, makeCtx({ exploratoryRunId: "xrun_abc" }));
    const rows = listTickLogs(db);
    expect(rows[0].tick_id).toBe("xrun_abc");
  });

  /**
   * Sleep concludes a tick, so it has to actually stop the loop — a model told
   * to stop in a tool result routinely keeps going. This used to run through a
   * private `workingMemory["tick_done"]` convention that only core tools could
   * discover; it is now the same `endsTurn` contract any tool can use.
   */
  it("ends the turn", async () => {
    const tool = new SleepTool(db);
    const result = await tool.execute({ reason: "nothing worth doing" }, makeCtx());
    expect(result.success).toBe(true);
    expect(result.endsTurn).toBe(true);
  });

  it("carries the tick's own words out as the loop's result", async () => {
    // Chat live_state reads what the tick reported; an opaque terminator makes
    // the chat agent blind to what the tick actually did.
    const tool = new SleepTool(db);
    const result = await tool.execute({ reason: "inbox already clear" }, makeCtx());
    expect(result.endsTurnReason).toBe("[Sleep] inbox already clear");
  });

  it("does not end the turn when it refused the call", async () => {
    const tool = new SleepTool(db);
    const result = await tool.execute({}, makeCtx());
    expect(result.success).toBe(false);
    expect(result.endsTurn).toBeUndefined();
  });
});
