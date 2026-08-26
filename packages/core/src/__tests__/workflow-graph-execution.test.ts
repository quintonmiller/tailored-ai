import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db/schema.js";
import { listWorkflowSteps } from "../db/workflow-queries.js";
import type { StepContext, StepExecutor, StepResult } from "../workflows/engine.js";
import { WorkflowEngine } from "../workflows/engine.js";
import { WorkflowRegistry } from "../workflows/registry.js";
import type { WorkflowStepDef } from "../workflows/types.js";

let db: Database.Database;
let registry: WorkflowRegistry;

class TimedExecutor implements StepExecutor {
  type = "tool_call" as const;
  events: Array<{ name: string; phase: "start" | "end"; t: number }> = [];
  delays: Record<string, number>;
  start: number;

  constructor(delays: Record<string, number>) {
    this.delays = delays;
    this.start = performance.now();
  }

  async execute(step: WorkflowStepDef, _ctx: StepContext): Promise<StepResult> {
    const delay = this.delays[step.name] ?? 50;
    this.events.push({ name: step.name, phase: "start", t: performance.now() - this.start });
    await new Promise((r) => setTimeout(r, delay));
    this.events.push({ name: step.name, phase: "end", t: performance.now() - this.start });
    return { output: `done:${step.name}` };
  }
}

beforeEach(() => {
  db = initDatabase(":memory:");
  registry = new WorkflowRegistry();
});

afterEach(() => {
  db.close();
});

describe("workflow graph execution", () => {
  it("executionMode: graph runs siblings of __trigger__ concurrently", async () => {
    const exec = new TimedExecutor({ a: 100, b: 100, joined: 30 });
    const engine = new WorkflowEngine({ db, registry, executors: [exec] });

    registry.register({
      name: "wf",
      executionMode: "graph",
      steps: [
        { name: "a", type: "tool_call", tool: "noop" },
        { name: "b", type: "tool_call", tool: "noop" },
        { name: "joined", type: "tool_call", tool: "noop" },
      ],
      graph: {
        nodes: [],
        edges: [
          { from: "__trigger__", to: "a" },
          { from: "__trigger__", to: "b" },
          { from: "a", to: "joined" },
          { from: "b", to: "joined" },
        ],
      },
    });

    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("completed");

    // Both a and b should start before either ends.
    const aStart = exec.events.find((e) => e.name === "a" && e.phase === "start")!;
    const bStart = exec.events.find((e) => e.name === "b" && e.phase === "start")!;
    const aEnd = exec.events.find((e) => e.name === "a" && e.phase === "end")!;
    expect(bStart.t).toBeLessThan(aEnd.t + 10);
    expect(Math.abs(aStart.t - bStart.t)).toBeLessThan(30);

    // joined runs after BOTH a and b have ended.
    const joinedStart = exec.events.find((e) => e.name === "joined" && e.phase === "start")!;
    const bEnd = exec.events.find((e) => e.name === "b" && e.phase === "end")!;
    expect(joinedStart.t).toBeGreaterThanOrEqual(Math.max(aEnd.t, bEnd.t) - 1);
  });

  it("executionMode: linear (default) preserves sequential order", async () => {
    const exec = new TimedExecutor({ a: 50, b: 50 });
    const engine = new WorkflowEngine({ db, registry, executors: [exec] });

    registry.register({
      name: "wf",
      // executionMode omitted -> defaults to linear
      steps: [
        { name: "a", type: "tool_call", tool: "noop" },
        { name: "b", type: "tool_call", tool: "noop" },
      ],
      graph: {
        nodes: [],
        edges: [
          { from: "__trigger__", to: "a" },
          { from: "__trigger__", to: "b" },
        ],
      },
    });

    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("completed");
    const aEnd = exec.events.find((e) => e.name === "a" && e.phase === "end")!;
    const bStart = exec.events.find((e) => e.name === "b" && e.phase === "start")!;
    expect(bStart.t).toBeGreaterThanOrEqual(aEnd.t - 1);
  });

  it("graph mode respects condition skip semantics", async () => {
    const exec: StepExecutor = {
      type: "tool_call",
      async execute(step) {
        return { output: `done:${step.name}` };
      },
    };
    const engine = new WorkflowEngine({ db, registry, executors: [exec] });

    // `if` is falsy → skip set = `then`. So `b` should not run; `a` should.
    registry.register({
      name: "wf",
      executionMode: "graph",
      steps: [
        { name: "decide", type: "condition", if: "1 == 2", then: ["b"] },
        { name: "a", type: "tool_call", tool: "noop" },
        { name: "b", type: "tool_call", tool: "noop" },
      ],
      graph: {
        nodes: [],
        edges: [
          { from: "__trigger__", to: "decide" },
          { from: "decide", to: "a" },
          { from: "decide", to: "b" },
        ],
      },
    });

    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("completed");
    const steps = listWorkflowSteps(db, run.id);
    const byName = new Map(steps.map((s) => [s.step_name, s]));
    expect(byName.get("a")?.status).toBe("completed");
    expect(byName.get("b")?.status).toBe("skipped");
  });

  it("computeDependencies maps edges into a per-step predecessor set", () => {
    const deps = WorkflowEngine.computeDependencies(
      [
        { name: "a", type: "tool_call", tool: "noop" },
        { name: "b", type: "tool_call", tool: "noop" },
        { name: "c", type: "tool_call", tool: "noop" },
      ],
      {
        nodes: [],
        edges: [
          { from: "__trigger__", to: "a" },
          { from: "__trigger__", to: "b" },
          { from: "a", to: "c" },
          { from: "b", to: "c" },
        ],
      },
    );
    expect([...(deps.get("a") ?? [])]).toEqual([]);
    expect([...(deps.get("b") ?? [])]).toEqual([]);
    expect(new Set(deps.get("c") ?? [])).toEqual(new Set(["a", "b"]));
  });
});
