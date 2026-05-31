import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db/schema.js";
import type { StepContext, StepExecutor, StepResult } from "../workflows/engine.js";
import { WorkflowEngine } from "../workflows/engine.js";
import { TriggerWorkflowExecutor } from "../workflows/executors/trigger-workflow.js";
import { WorkflowRegistry } from "../workflows/registry.js";
import type { WorkflowStepDef } from "../workflows/types.js";

class EchoInputExecutor implements StepExecutor {
  type = "tool_call" as const;
  async execute(_step: WorkflowStepDef, ctx: StepContext): Promise<StepResult> {
    return { output: ctx.scope.input };
  }
}

let db: Database.Database;
let registry: WorkflowRegistry;
let engine: WorkflowEngine;

beforeEach(() => {
  db = initDatabase(":memory:");
  registry = new WorkflowRegistry();
  engine = new WorkflowEngine({
    db,
    registry,
    executors: [new EchoInputExecutor(), new TriggerWorkflowExecutor()],
  });
});

afterEach(() => {
  db.close();
});

describe("TriggerWorkflowExecutor", () => {
  it("runs the named child workflow and surfaces its output", async () => {
    registry.register({
      name: "child",
      steps: [{ name: "echo", type: "tool_call", tool: "anything" }],
    });
    registry.register({
      name: "parent",
      steps: [
        {
          name: "run-child",
          type: "trigger_workflow",
          workflow: "child",
          input: { greeting: "hi from parent" },
        },
      ],
    });

    const run = await engine.runWorkflow("parent");
    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ greeting: "hi from parent" });
  });

  it("threads scope through to the child's input", async () => {
    registry.register({
      name: "child",
      steps: [{ name: "echo", type: "tool_call", tool: "anything" }],
    });
    registry.register({
      name: "parent",
      steps: [
        {
          name: "run-child",
          type: "trigger_workflow",
          workflow: "child",
          input: { who: "${input.who}" },
        },
      ],
    });

    const run = await engine.runWorkflow("parent", { who: "bob" });
    expect(run.output).toEqual({ who: "bob" });
  });

  it("fails the parent when the child fails", async () => {
    class FailingExecutor implements StepExecutor {
      type = "tool_call" as const;
      async execute(): Promise<StepResult> {
        throw new Error("child kaboom");
      }
    }
    engine = new WorkflowEngine({
      db,
      registry,
      executors: [new FailingExecutor(), new TriggerWorkflowExecutor()],
    });
    registry.register({
      name: "child",
      steps: [{ name: "boom", type: "tool_call", tool: "x" }],
    });
    registry.register({
      name: "parent",
      steps: [{ name: "run-child", type: "trigger_workflow", workflow: "child" }],
    });

    const run = await engine.runWorkflow("parent");
    expect(run.status).toBe("failed");
    expect(run.error).toContain('trigger_workflow "child" failed');
  });

  it("raises when the child workflow isn't registered", async () => {
    registry.register({
      name: "parent",
      steps: [{ name: "run-ghost", type: "trigger_workflow", workflow: "ghost" }],
    });
    const run = await engine.runWorkflow("parent");
    expect(run.status).toBe("failed");
    expect(run.error).toContain("unknown workflow: ghost");
  });

  it("fireAndForget returns immediately with a marker output", async () => {
    registry.register({
      name: "child",
      steps: [{ name: "echo", type: "tool_call", tool: "anything" }],
    });
    registry.register({
      name: "parent",
      steps: [
        {
          name: "kick",
          type: "trigger_workflow",
          workflow: "child",
          fireAndForget: true,
        },
      ],
    });

    const run = await engine.runWorkflow("parent");
    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ workflow: "child", fireAndForget: true });
  });
});
