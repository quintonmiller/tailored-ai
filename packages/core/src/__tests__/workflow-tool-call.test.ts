import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDatabase } from "../db/schema.js";
import { listWorkflowSteps } from "../db/workflow-queries.js";
import type { Tool, ToolContext, ToolResult } from "../tools/interface.js";
import { WorkflowEngine } from "../workflows/engine.js";
import { ToolCallExecutor } from "../workflows/executors/tool-call.js";
import { WorkflowRegistry } from "../workflows/registry.js";

class FakeTool implements Tool {
  name: string;
  description = "fake";
  parameters = {};
  invoke = vi.fn<(args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>>();
  constructor(name: string, impl?: typeof this.invoke) {
    this.name = name;
    if (impl) this.invoke = impl;
  }
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    return this.invoke(args, ctx);
  }
}

let db: Database.Database;
let registry: WorkflowRegistry;
let engine: WorkflowEngine;

beforeEach(() => {
  db = initDatabase(":memory:");
  registry = new WorkflowRegistry();
});

afterEach(() => {
  db.close();
});

describe("ToolCallExecutor", () => {
  it("invokes the named tool with resolved args and returns its output", async () => {
    const tool = new FakeTool(
      "echo",
      vi.fn(async (args) => ({ success: true, output: `hi ${args.name}` })),
    );
    engine = new WorkflowEngine({
      db,
      registry,
      executors: [new ToolCallExecutor({ getTools: () => [tool] })],
    });
    registry.register({
      name: "wf",
      steps: [
        {
          name: "greet",
          type: "tool_call",
          tool: "echo",
          args: { name: "${input.who}" },
        },
      ],
    });
    const run = await engine.runWorkflow("wf", { who: "alice" });
    expect(run.status).toBe("completed");
    expect(run.output).toBe("hi alice");
    expect(tool.invoke).toHaveBeenCalledWith(
      { name: "alice" },
      expect.objectContaining({ sessionId: `workflow:${run.id}:greet` }),
    );
  });

  it("threads earlier step outputs through args", async () => {
    const fetcher = new FakeTool(
      "fetch",
      vi.fn(async () => ({ success: true, output: "raw-data" })),
    );
    const writer = new FakeTool(
      "write",
      vi.fn(async () => ({ success: true, output: "wrote" })),
    );
    engine = new WorkflowEngine({
      db,
      registry,
      executors: [new ToolCallExecutor({ getTools: () => [fetcher, writer] })],
    });
    registry.register({
      name: "wf",
      steps: [
        { name: "fetch", type: "tool_call", tool: "fetch" },
        {
          name: "write",
          type: "tool_call",
          tool: "write",
          args: { content: "${steps.fetch}" },
        },
      ],
    });
    await engine.runWorkflow("wf");
    expect(writer.invoke).toHaveBeenCalledWith(
      { content: "raw-data" },
      expect.objectContaining({ sessionId: expect.any(String) }),
    );
  });

  it("raises (and fails the run) when the tool reports success: false", async () => {
    const tool = new FakeTool(
      "broken",
      vi.fn(async () => ({ success: false, output: "", error: "kaboom" })),
    );
    engine = new WorkflowEngine({
      db,
      registry,
      executors: [new ToolCallExecutor({ getTools: () => [tool] })],
    });
    registry.register({
      name: "wf",
      steps: [{ name: "x", type: "tool_call", tool: "broken" }],
    });
    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("failed");
    expect(run.error).toContain("kaboom");
  });

  it("raises when the tool name is not registered", async () => {
    engine = new WorkflowEngine({
      db,
      registry,
      executors: [new ToolCallExecutor({ getTools: () => [] })],
    });
    registry.register({
      name: "wf",
      steps: [{ name: "x", type: "tool_call", tool: "missing" }],
    });
    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("failed");
    expect(run.error).toContain('"missing"');
  });

  it("retries on tool failure when retry policy is set", async () => {
    let calls = 0;
    const tool = new FakeTool(
      "flaky",
      vi.fn(async () => {
        calls++;
        if (calls < 3) return { success: false, output: "", error: "transient" };
        return { success: true, output: "ok" };
      }),
    );
    engine = new WorkflowEngine({
      db,
      registry,
      executors: [new ToolCallExecutor({ getTools: () => [tool] })],
    });
    registry.register({
      name: "wf",
      steps: [
        {
          name: "x",
          type: "tool_call",
          tool: "flaky",
          retry: { maxAttempts: 3, backoffMs: 0 },
        },
      ],
    });
    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("completed");
    expect(calls).toBe(3);
    const steps = listWorkflowSteps(db, run.id);
    expect(steps[0].attempt).toBe(3);
  });
});
