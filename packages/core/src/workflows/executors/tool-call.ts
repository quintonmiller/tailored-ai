import { resolveValue } from "../scope.js";
import type { StepContext, StepExecutor, StepResult } from "../engine.js";
import type { ToolCallStep, WorkflowStepDef } from "../types.js";
import type { Tool, ToolContext } from "../../tools/interface.js";

export interface ToolCallExecutorOptions {
  getTools: () => Tool[];
  workingDirectory?: string;
  env?: Record<string, string>;
}

/**
 * Invokes a single tool from the runtime's tool set with arguments
 * resolved against the workflow scope. Output is the tool's `output`
 * string. Failure (`success: false`) raises so the engine can apply
 * onError/retry policies.
 *
 * No agent loop, no model. For side-effect-only steps.
 */
export class ToolCallExecutor implements StepExecutor {
  type = "tool_call" as const;
  private getTools: () => Tool[];
  private workingDirectory: string;
  private env: Record<string, string>;

  constructor(opts: ToolCallExecutorOptions) {
    this.getTools = opts.getTools;
    this.workingDirectory = opts.workingDirectory ?? process.cwd();
    this.env = opts.env ?? (process.env as Record<string, string>);
  }

  async execute(step: WorkflowStepDef, ctx: StepContext): Promise<StepResult> {
    const s = step as ToolCallStep;
    const tools = this.getTools();
    const tool = tools.find((t) => t.name === s.tool);
    if (!tool) throw new Error(`tool_call: tool "${s.tool}" is not registered`);

    const args = (resolveValue(s.args ?? {}, ctx.scope) ?? {}) as Record<string, unknown>;

    const toolCtx: ToolContext = {
      sessionId: `workflow:${ctx.runId}:${s.name}`,
      workingDirectory: this.workingDirectory,
      env: this.env,
      agentName: "workflow",
    };

    const result = await tool.execute(args, toolCtx);
    if (!result.success) {
      throw new Error(`tool_call "${s.tool}" failed: ${result.error ?? result.output}`);
    }
    return { output: result.output };
  }
}
