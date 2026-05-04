export type StepType =
  | "agent_run"
  | "tool_call"
  | "shell"
  | "condition"
  | "loop"
  | "parallel";

export type OnErrorPolicy = "fail" | "continue" | "retry";

export interface RetryPolicy {
  maxAttempts: number;
  backoffMs?: number;
}

export interface BaseStep {
  name: string;
  type: StepType;
  deadlineMs?: number;
  onError?: OnErrorPolicy;
  retry?: RetryPolicy;
}

export interface AgentRunStep extends BaseStep {
  type: "agent_run";
  agent: string;
  prompt: string;
  maxToolRounds?: number;
  modelOverride?: string;
}

export interface ToolCallStep extends BaseStep {
  type: "tool_call";
  tool: string;
  args?: Record<string, unknown>;
}

export interface ShellStep extends BaseStep {
  type: "shell";
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ConditionStep extends BaseStep {
  type: "condition";
  if: string;
  then?: string[];
  else?: string[];
}

export interface LoopStep extends BaseStep {
  type: "loop";
  over: string;
  as: string;
  body: WorkflowStepDef[];
  parallel?: boolean;
  maxConcurrency?: number;
}

export interface ParallelStep extends BaseStep {
  type: "parallel";
  steps: WorkflowStepDef[];
}

export type WorkflowStepDef =
  | AgentRunStep
  | ToolCallStep
  | ShellStep
  | ConditionStep
  | LoopStep
  | ParallelStep;

export interface WorkflowDefinition {
  name: string;
  description?: string;
  deadlineMs?: number;
  steps: WorkflowStepDef[];
}

export interface RegisteredWorkflow {
  definition: WorkflowDefinition;
  /** Source path (when loaded from disk) or "programmatic". */
  source: string;
  /** Runtime generation when registered. */
  generation: number;
}
