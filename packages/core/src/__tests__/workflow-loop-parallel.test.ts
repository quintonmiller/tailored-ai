import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db/schema.js";
import { listWorkflowSteps } from "../db/workflow-queries.js";
import { type StepContext, type StepExecutor, type StepResult, WorkflowEngine } from "../workflows/engine.js";
import { LoopExecutor } from "../workflows/executors/loop.js";
import { ParallelExecutor } from "../workflows/executors/parallel.js";
import { WorkflowRegistry } from "../workflows/registry.js";
import type { WorkflowStepDef } from "../workflows/types.js";

class EchoExecutor implements StepExecutor {
  type = "shell" as const;
  inflight = 0;
  maxInflight = 0;
  delay = 0;

  async execute(step: WorkflowStepDef, ctx: StepContext): Promise<StepResult> {
    this.inflight++;
    if (this.inflight > this.maxInflight) this.maxInflight = this.inflight;
    try {
      // Resolve ${...} in the command using engine.resolve
      const resolved = ctx.engine.resolve((step as { command?: string }).command, ctx.scope);
      if (this.delay > 0) await new Promise((r) => setTimeout(r, this.delay));
      return { output: String(resolved ?? "") };
    } finally {
      this.inflight--;
    }
  }
}

let db: Database.Database;
let registry: WorkflowRegistry;
let echo: EchoExecutor;
let engine: WorkflowEngine;

beforeEach(() => {
  db = initDatabase(":memory:");
  registry = new WorkflowRegistry();
  echo = new EchoExecutor();
  engine = new WorkflowEngine({
    db,
    registry,
    executors: [echo, new LoopExecutor(), new ParallelExecutor()],
  });
});

afterEach(() => {
  db.close();
});

describe("LoopExecutor", () => {
  it("iterates body sequentially over an input array", async () => {
    registry.register({
      name: "wf",
      steps: [
        {
          name: "fan",
          type: "loop",
          over: "${input.items}",
          as: "item",
          body: [{ name: "iter", type: "shell", command: "got=${item}" }],
        },
      ],
    });
    const run = await engine.runWorkflow("wf", { items: ["a", "b", "c"] });
    expect(run.status).toBe("completed");
    expect(run.output).toEqual(["got=a", "got=b", "got=c"]);
  });

  it("exposes loop var, index, and outer scope inside the body", async () => {
    registry.register({
      name: "wf",
      steps: [
        {
          name: "loop",
          type: "loop",
          over: "${input.items}",
          as: "x",
          body: [{ name: "step", type: "shell", command: "${x_index}=${x}@${input.suffix}" }],
        },
      ],
    });
    const run = await engine.runWorkflow("wf", { items: ["foo", "bar"], suffix: "Z" });
    expect(run.output).toEqual(["0=foo@Z", "1=bar@Z"]);
  });

  it("parallel loop runs iterations concurrently up to maxConcurrency", async () => {
    echo.delay = 50;
    registry.register({
      name: "wf",
      steps: [
        {
          name: "fan",
          type: "loop",
          over: "${input.items}",
          as: "i",
          parallel: true,
          maxConcurrency: 3,
          body: [{ name: "do", type: "shell", command: "i=${i}" }],
        },
      ],
    });
    await engine.runWorkflow("wf", { items: [1, 2, 3, 4, 5, 6] });
    expect(echo.maxInflight).toBeGreaterThanOrEqual(2);
    expect(echo.maxInflight).toBeLessThanOrEqual(3);
  });

  it("rejects when over does not resolve to an array", async () => {
    registry.register({
      name: "wf",
      steps: [
        {
          name: "bad",
          type: "loop",
          over: "${input.notArray}",
          as: "x",
          body: [{ name: "x", type: "shell", command: "echo" }],
        },
      ],
    });
    const run = await engine.runWorkflow("wf", { notArray: "scalar" });
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/must resolve to an array/);
  });

  it("records loop body steps with parent_step_id pointing at the loop", async () => {
    registry.register({
      name: "wf",
      steps: [
        {
          name: "outer",
          type: "loop",
          over: "${input.items}",
          as: "x",
          body: [{ name: "inner", type: "shell", command: "x=${x}" }],
        },
      ],
    });
    const run = await engine.runWorkflow("wf", { items: ["a", "b"] });
    const steps = listWorkflowSteps(db, run.id);
    const outer = steps.find((s) => s.step_name === "outer");
    expect(outer).toBeDefined();
    const children = steps.filter((s) => s.parent_step_id === outer!.id);
    expect(children).toHaveLength(2);
    expect(children.every((c) => c.step_name === "inner")).toBe(true);
  });
});

describe("ParallelExecutor", () => {
  it("runs all children concurrently and returns name → output", async () => {
    echo.delay = 30;
    registry.register({
      name: "wf",
      steps: [
        {
          name: "gather",
          type: "parallel",
          steps: [
            { name: "a", type: "shell", command: "out-a" },
            { name: "b", type: "shell", command: "out-b" },
            { name: "c", type: "shell", command: "out-c" },
          ],
        },
      ],
    });
    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ a: "out-a", b: "out-b", c: "out-c" });
    expect(echo.maxInflight).toBeGreaterThanOrEqual(2);
  });

  it("a child failure fails the whole parallel step (default onError)", async () => {
    let calls = 0;
    const flaky: StepExecutor = {
      type: "shell",
      async execute(step) {
        calls++;
        if ((step as { command: string }).command === "boom") {
          throw new Error("kaboom");
        }
        return { output: "ok" };
      },
    };
    engine = new WorkflowEngine({
      db,
      registry,
      executors: [flaky, new ParallelExecutor()],
    });
    registry.register({
      name: "wf",
      steps: [
        {
          name: "gather",
          type: "parallel",
          steps: [
            { name: "fine", type: "shell", command: "ok" },
            { name: "broken", type: "shell", command: "boom" },
          ],
        },
      ],
    });
    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/kaboom/);
    expect(calls).toBe(2);
  });

  it("child onError: continue lets the parallel succeed even when one fails", async () => {
    const flaky: StepExecutor = {
      type: "shell",
      async execute(step) {
        if ((step as { command: string }).command === "boom") throw new Error("kaboom");
        return { output: "ok" };
      },
    };
    engine = new WorkflowEngine({
      db,
      registry,
      executors: [flaky, new ParallelExecutor()],
    });
    registry.register({
      name: "wf",
      steps: [
        {
          name: "gather",
          type: "parallel",
          steps: [
            { name: "fine", type: "shell", command: "ok" },
            { name: "soft", type: "shell", command: "boom", onError: "continue" },
          ],
        },
      ],
    });
    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("completed");
    expect(run.output).toEqual({ fine: "ok", soft: null });
  });
});
