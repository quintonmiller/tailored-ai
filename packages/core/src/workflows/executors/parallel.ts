import type { StepContext, StepExecutor, StepResult } from "../engine.js";
import type { ParallelStep, WorkflowStepDef } from "../types.js";

/**
 * Runs a group of named child steps concurrently and joins. Output is
 * an object `{ <child-name>: <child-output> }`. The whole step fails
 * if any child fails (unless that child has its own onError: continue).
 *
 * Children do not see each other in scope — the design doc deliberately
 * keeps `${steps.<peer>}` unresolvable to prevent race-y reads. They
 * still see outer `input`, `steps`, `prev`, `env`, and any loop `vars`.
 */
export class ParallelExecutor implements StepExecutor {
  type = "parallel" as const;

  async execute(step: WorkflowStepDef, ctx: StepContext): Promise<StepResult> {
    const s = step as ParallelStep;

    const tasks = s.steps.map((child) =>
      ctx.engine
        .runStep(child, ctx.scope, ctx.signal, ctx.runId, ctx.stepId)
        .then((res) => ({ name: child.name, output: res.output })),
    );

    const settled = await Promise.allSettled(tasks);
    const failures = settled
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => (r.reason as Error).message);
    if (failures.length > 0) {
      throw new Error(
        `parallel step "${s.name}" had ${failures.length} child failure(s): ${failures.join("; ")}`,
      );
    }

    const outputs: Record<string, unknown> = {};
    for (const r of settled) {
      if (r.status === "fulfilled") outputs[r.value.name] = r.value.output;
    }
    return { output: outputs };
  }
}
