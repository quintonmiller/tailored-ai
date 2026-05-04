import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db/schema.js";
import { listWorkflowSteps } from "../db/workflow-queries.js";
import {
  CancelledError,
  DeadlineError,
  WorkflowEngine,
  WorkflowError,
  type StepContext,
  type StepExecutor,
  type StepResult,
} from "../workflows/engine.js";
import { WorkflowRegistry } from "../workflows/registry.js";
import type { WorkflowStepDef } from "../workflows/types.js";

interface CallableStep extends WorkflowStepDef {
  type: "shell";
  command: string;
  // Test-only marker for our fake executor
  __fail?: number; // fail this many attempts before succeeding
  __delay?: number; // ms
  __returns?: unknown;
}

class TestExecutor implements StepExecutor {
  type = "shell" as const;
  /** number of times each step name has been called */
  calls = new Map<string, number>();
  /** static plan: per-step name → impl override */
  plans = new Map<
    string,
    (step: CallableStep, ctx: StepContext, callIdx: number) => Promise<StepResult>
  >();

  setPlan(
    name: string,
    fn: (step: CallableStep, ctx: StepContext, callIdx: number) => Promise<StepResult>,
  ): void {
    this.plans.set(name, fn);
  }

  async execute(step: WorkflowStepDef, ctx: StepContext): Promise<StepResult> {
    const s = step as CallableStep;
    const callIdx = (this.calls.get(s.name) ?? 0) + 1;
    this.calls.set(s.name, callIdx);
    const plan = this.plans.get(s.name);
    if (plan) return plan(s, ctx, callIdx);
    if (s.__delay) await new Promise((r) => setTimeout(r, s.__delay));
    if (s.__fail && callIdx <= s.__fail) {
      throw new Error(`fail #${callIdx} on ${s.name}`);
    }
    return { output: s.__returns ?? `out:${s.name}` };
  }
}

let db: Database.Database;
let registry: WorkflowRegistry;
let executor: TestExecutor;
let engine: WorkflowEngine;

beforeEach(() => {
  db = initDatabase(":memory:");
  registry = new WorkflowRegistry();
  executor = new TestExecutor();
  engine = new WorkflowEngine({
    db,
    registry,
    executors: [executor],
    maxConcurrent: 4,
  });
});

afterEach(() => {
  db.close();
});

describe("WorkflowEngine — sequential execution", () => {
  it("runs all steps in order and threads outputs into scope", async () => {
    registry.register({
      name: "wf",
      steps: [
        { name: "first", type: "shell", command: "echo first" },
        { name: "second", type: "shell", command: "echo second" } as WorkflowStepDef,
      ],
    });
    executor.setPlan("first", async () => ({ output: "alpha" }));
    executor.setPlan("second", async (_, ctx) => ({
      output: `prev=${ctx.scope.prev}, first=${(ctx.scope.steps as Record<string, unknown>).first}`,
    }));
    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("completed");
    expect(run.output).toBe("prev=alpha, first=alpha");
    const steps = listWorkflowSteps(db, run.id);
    expect(steps.map((s) => s.status)).toEqual(["completed", "completed"]);
  });

  it("fails the run when a step fails (default onError=fail)", async () => {
    registry.register({
      name: "wf",
      steps: [
        { name: "ok", type: "shell", command: "x" },
        { name: "boom", type: "shell", command: "x", __fail: 9 } as CallableStep,
        { name: "never", type: "shell", command: "x" },
      ],
    });
    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("failed");
    expect(run.error).toContain("fail #1 on boom");
    const steps = listWorkflowSteps(db, run.id);
    expect(steps.map((s) => `${s.step_name}:${s.status}`)).toEqual([
      "ok:completed",
      "boom:failed",
    ]);
  });

  it("onError=continue records failure but moves on with null output", async () => {
    registry.register({
      name: "wf",
      steps: [
        {
          name: "soft",
          type: "shell",
          command: "x",
          __fail: 9,
          onError: "continue",
        } as CallableStep,
        { name: "after", type: "shell", command: "x" },
      ],
    });
    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("completed");
    const steps = listWorkflowSteps(db, run.id);
    expect(steps.find((s) => s.step_name === "soft")?.status).toBe("failed");
    expect(steps.find((s) => s.step_name === "after")?.status).toBe("completed");
  });

  it("retry policy retries until success or exhaustion", async () => {
    registry.register({
      name: "wf",
      steps: [
        {
          name: "flaky",
          type: "shell",
          command: "x",
          __fail: 2,
          retry: { maxAttempts: 3, backoffMs: 0 },
        } as CallableStep,
      ],
    });
    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("completed");
    expect(executor.calls.get("flaky")).toBe(3);
  });

  it("retry exhaustion fails the run", async () => {
    registry.register({
      name: "wf",
      steps: [
        {
          name: "doomed",
          type: "shell",
          command: "x",
          __fail: 9,
          retry: { maxAttempts: 2, backoffMs: 0 },
        } as CallableStep,
      ],
    });
    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("failed");
    expect(executor.calls.get("doomed")).toBe(2);
  });
});

describe("WorkflowEngine — deadlines", () => {
  it("aborts a step that exceeds deadlineMs", async () => {
    registry.register({
      name: "wf",
      steps: [
        {
          name: "slow",
          type: "shell",
          command: "x",
          deadlineMs: 30,
        } as WorkflowStepDef,
      ],
    });
    executor.setPlan("slow", async (_, ctx) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 200);
        ctx.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      });
      return { output: "done" };
    });
    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/deadlineMs|aborted/);
  });

  it("workflow-level deadline cancels remaining steps", async () => {
    registry.register({
      name: "wf",
      deadlineMs: 30,
      steps: [
        { name: "slow", type: "shell", command: "x", __delay: 200 } as CallableStep,
        { name: "after", type: "shell", command: "x" } as CallableStep,
      ],
    });
    const run = await engine.runWorkflow("wf");
    // workflow-level deadline aborts the abort controller; step gets a cancel and rejects
    expect(["cancelled", "failed"]).toContain(run.status);
    const steps = listWorkflowSteps(db, run.id);
    expect(steps.find((s) => s.step_name === "after")).toBeUndefined();
  });
});

describe("WorkflowEngine — cancellation", () => {
  it("cancel() during a long step results in cancelled status", async () => {
    registry.register({
      name: "wf",
      steps: [
        { name: "slow", type: "shell", command: "x" },
        { name: "after", type: "shell", command: "x" },
      ],
    });
    let cancelTarget: string | undefined;
    executor.setPlan("slow", async (_, ctx) => {
      cancelTarget = ctx.runId;
      // Trigger cancel from within the step
      setTimeout(() => engine.cancel(ctx.runId), 5);
      await new Promise<void>((resolve, reject) => {
        ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
        setTimeout(resolve, 500);
      });
      return { output: "no" };
    });
    const run = await engine.runWorkflow("wf");
    expect(cancelTarget).toBe(run.id);
    expect(run.status).toBe("cancelled");
  });
});

describe("WorkflowEngine — condition step", () => {
  it("when truthy, then-branch steps run and else-branch are skipped", async () => {
    registry.register({
      name: "wf",
      steps: [
        { name: "decide", type: "condition", if: "true", then: ["yes"], else: ["no"] },
        { name: "yes", type: "shell", command: "x" },
        { name: "no", type: "shell", command: "x" },
      ],
    });
    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("completed");
    const steps = listWorkflowSteps(db, run.id);
    const status = (n: string) => steps.find((s) => s.step_name === n)?.status;
    expect(status("decide")).toBe("completed");
    expect(status("yes")).toBe("completed");
    expect(status("no")).toBe("skipped");
  });

  it("falsy condition skips then-branch", async () => {
    registry.register({
      name: "wf",
      steps: [
        { name: "decide", type: "condition", if: "false", then: ["yes"] },
        { name: "yes", type: "shell", command: "x" },
        { name: "always", type: "shell", command: "x" },
      ],
    });
    const run = await engine.runWorkflow("wf");
    const steps = listWorkflowSteps(db, run.id);
    expect(steps.find((s) => s.step_name === "yes")?.status).toBe("skipped");
    expect(steps.find((s) => s.step_name === "always")?.status).toBe("completed");
  });
});

describe("WorkflowEngine — concurrency and registration", () => {
  it("rejects unknown workflow names", async () => {
    await expect(engine.runWorkflow("nope")).rejects.toThrow(WorkflowError);
  });

  it("respects maxConcurrent global cap", async () => {
    engine = new WorkflowEngine({
      db,
      registry,
      executors: [executor],
      maxConcurrent: 1,
    });
    registry.register({
      name: "wf",
      steps: [{ name: "s", type: "shell", command: "x", __delay: 30 } as CallableStep],
    });
    const order: number[] = [];
    const wrap = async (i: number) => {
      const run = await engine.runWorkflow("wf");
      order.push(i);
      return run;
    };
    const a = wrap(1);
    const b = wrap(2);
    await Promise.all([a, b]);
    // With cap=1, b cannot finish before a starts; a starts before b.
    expect(order).toEqual([1, 2]);
  });

  it("promoteOrphanedRuns marks pending/running rows as interrupted", async () => {
    registry.register({
      name: "wf",
      steps: [{ name: "s", type: "shell", command: "x", __delay: 200 } as CallableStep],
    });
    // Don't await — leave the run in flight
    const inflight = engine.runWorkflow("wf");
    await new Promise((r) => setTimeout(r, 5));
    const promoted = WorkflowEngine.promoteOrphanedRuns(db);
    expect(promoted).toBeGreaterThanOrEqual(1);
    // Cancel the in-flight run so the test can complete cleanly
    const active = inflight; // already returns a promise
    engine.cancel((await active).id);
    await active;
  });
});

describe("WorkflowEngine — DeadlineError surfaces with retry", () => {
  it("retry is applied to deadline failures too", async () => {
    registry.register({
      name: "wf",
      steps: [
        {
          name: "tight",
          type: "shell",
          command: "x",
          deadlineMs: 10,
          retry: { maxAttempts: 2, backoffMs: 0 },
        } as WorkflowStepDef,
      ],
    });
    let calls = 0;
    executor.setPlan("tight", async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 100));
      return { output: "no" };
    });
    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/DeadlineError|deadlineMs/);
    expect(calls).toBe(2);
  });

  it("DeadlineError class is recognizable", () => {
    expect(new DeadlineError().name).toBe("DeadlineError");
    expect(new CancelledError().name).toBe("CancelledError");
  });
});
