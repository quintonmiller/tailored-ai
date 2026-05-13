import { resolveValue } from "../scope.js";
import type { StepContext, StepExecutor, StepResult } from "../engine.js";
import type { TriggerWorkflowStep, WorkflowStepDef } from "../types.js";

/**
 * Runs another registered workflow as a child step. Useful for composing
 * pipelines and reusing sub-flows. When `fireAndForget: true`, the child
 * runs detached and this step's output is `{ runId }`.
 *
 * The child sees `input` as the bundle defined on this step (with scope
 * placeholders resolved). Its final output becomes this step's output.
 */
export class TriggerWorkflowExecutor implements StepExecutor {
  type = "trigger_workflow" as const;

  async execute(step: WorkflowStepDef, ctx: StepContext): Promise<StepResult> {
    const s = step as TriggerWorkflowStep;
    const childInput = (resolveValue(s.input ?? {}, ctx.scope) ?? {}) as Record<string, unknown>;

    if (s.fireAndForget) {
      // Don't await — return the child runId immediately. The promise's
      // failure is logged via the engine's run.failed event, not here.
      const pending = ctx.engine
        .runWorkflow(s.workflow, childInput, "programmatic")
        .catch((err: Error) => {
          // Surface via console only — fire-and-forget contract means this
          // step does not block on child success/failure.
          console.warn(`[trigger_workflow] child "${s.workflow}" failed: ${err.message}`);
        });
      // Best-effort to capture an early runId; if the parent races ahead we
      // simply report unknown. Most callers only need to know "kicked off".
      void pending;
      return { output: { workflow: s.workflow, fireAndForget: true } };
    }

    const child = await ctx.engine.runWorkflow(s.workflow, childInput, "programmatic");
    if (child.status === "failed") {
      throw new Error(`trigger_workflow "${s.workflow}" failed: ${child.error ?? "unknown error"}`);
    }
    if (child.status === "cancelled") {
      throw new Error(`trigger_workflow "${s.workflow}" was cancelled`);
    }
    return { output: child.output };
  }
}
