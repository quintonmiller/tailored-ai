import { resolveString } from "../scope.js";
import type { Scope } from "../scope.js";
import { Semaphore } from "../semaphore.js";
import type { StepContext, StepExecutor, StepResult } from "../engine.js";
import type { LoopStep, WorkflowStepDef } from "../types.js";

const DEFAULT_PARALLEL_CONCURRENCY = 4;

/**
 * Iterates a body (array of steps) over a scope-resolved array. Each
 * iteration binds the current item to `${as}` in the body's scope and
 * sees the body steps' own `steps.*` and `prev`.
 *
 * Output: array of per-iteration outputs (the last body step's output
 * for that iteration, or null if the body produced no steps).
 */
export class LoopExecutor implements StepExecutor {
  type = "loop" as const;

  async execute(step: WorkflowStepDef, ctx: StepContext): Promise<StepResult> {
    const s = step as LoopStep;
    const items = resolveString(s.over, ctx.scope);
    if (!Array.isArray(items)) {
      throw new Error(`loop "${s.name}".over must resolve to an array, got ${typeof items}`);
    }

    if (s.parallel) {
      const cap = s.maxConcurrency ?? DEFAULT_PARALLEL_CONCURRENCY;
      const sema = new Semaphore(Math.max(1, cap));
      const tasks = items.map((item, idx) =>
        (async () => {
          const release = await sema.acquire();
          try {
            return await this.runIteration(s, item, idx, ctx);
          } finally {
            release();
          }
        })(),
      );
      const outputs = await Promise.all(tasks);
      return { output: outputs };
    }

    const outputs: unknown[] = [];
    for (let i = 0; i < items.length; i++) {
      if (ctx.signal.aborted) throw new Error("workflow cancelled");
      outputs.push(await this.runIteration(s, items[i], i, ctx));
    }
    return { output: outputs };
  }

  private async runIteration(
    step: LoopStep,
    item: unknown,
    index: number,
    ctx: StepContext,
  ): Promise<unknown> {
    const childScope: Scope = {
      ...ctx.scope,
      vars: { ...(ctx.scope.vars ?? {}), [step.as]: item, [`${step.as}_index`]: index },
    };
    const childOutputs = await ctx.engine.runStepList(
      step.body,
      childScope,
      ctx.signal,
      ctx.runId,
      ctx.stepId,
    );
    const lastStep = step.body[step.body.length - 1];
    return childOutputs[lastStep?.name] ?? null;
  }
}
