import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  WorkflowEngine,
  WorkflowRegistry,
  RunWorkflowTool,
  defineWorkflow,
  initDatabase,
  type StepExecutor,
  type StepResult,
  type WorkflowStepDef,
  type ToolContext,
} from "../index.js";

class EchoExec implements StepExecutor {
  type = "shell" as const;
  async execute(step: WorkflowStepDef): Promise<StepResult> {
    return { output: `out:${(step as { command: string }).command}` };
  }
}

let db: Database.Database;
let registry: WorkflowRegistry;
let engine: WorkflowEngine;
let tool: RunWorkflowTool;

const ctx: ToolContext = {
  sessionId: "test",
  workingDirectory: process.cwd(),
  env: {},
};

beforeEach(() => {
  db = initDatabase(":memory:");
  registry = new WorkflowRegistry();
  engine = new WorkflowEngine({
    db,
    registry,
    executors: [new EchoExec()],
  });
  tool = new RunWorkflowTool({
    getEngine: () => engine,
    getRegistry: () => registry,
  });
});

afterEach(() => {
  db.close();
});

describe("defineWorkflow", () => {
  it("is an identity function preserving the definition shape", () => {
    const wf = defineWorkflow({
      name: "demo",
      steps: [{ name: "x", type: "shell", command: "echo" }],
    });
    expect(wf.name).toBe("demo");
    expect(wf.steps[0].type).toBe("shell");
  });
});

describe("RunWorkflowTool", () => {
  beforeEach(() => {
    registry.register(
      defineWorkflow({
        name: "demo",
        steps: [{ name: "step1", type: "shell", command: "hello" }],
      }),
    );
  });

  it("runs a workflow synchronously and returns the final output", async () => {
    const result = await tool.execute({ name: "demo", input: { who: "x" } }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toBe("out:hello");
  });

  it("rejects when name is missing", async () => {
    const result = await tool.execute({}, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/name/);
  });

  it("rejects unknown workflow names", async () => {
    const result = await tool.execute({ name: "ghost" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unknown workflow/);
  });

  it("returns error when no engine is wired", async () => {
    const detached = new RunWorkflowTool({
      getEngine: () => undefined,
      getRegistry: () => registry,
    });
    const result = await detached.execute({ name: "demo" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/engine is not configured/);
  });

  it("async: true returns a background task id immediately", async () => {
    const result = await tool.execute({ name: "demo", async: true }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/Background workflow started: task_/);
  });

  it("surfaces a workflow failure as success: false", async () => {
    const failing: StepExecutor = {
      type: "shell",
      async execute() {
        throw new Error("kaboom");
      },
    };
    const failEngine = new WorkflowEngine({
      db,
      registry,
      executors: [failing],
    });
    const failTool = new RunWorkflowTool({
      getEngine: () => failEngine,
      getRegistry: () => registry,
    });
    const result = await failTool.execute({ name: "demo" }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/kaboom/);
  });
});
