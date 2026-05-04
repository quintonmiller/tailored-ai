import type Database from "better-sqlite3";
import { runAgentLoop, type AgentLoopOptions } from "../../agent/loop.js";
import { newSession } from "../../agent/session.js";
import { resolveString } from "../scope.js";
import type { StepContext, StepExecutor, StepResult } from "../engine.js";
import type { AgentRunStep, WorkflowStepDef } from "../types.js";
import type { AgentRuntime } from "../../runtime.js";

export interface AgentRunExecutorOptions {
  runtime: AgentRuntime;
  db: Database.Database;
  /** Override the agent loop function — primarily for tests. */
  runAgentLoop?: (prompt: string, opts: AgentLoopOptions) => Promise<string>;
}

/**
 * Runs an agent loop as a workflow step. Each invocation creates a fresh
 * ephemeral session keyed `workflow:<runId>:<stepName>`. The step name
 * is the agent's response string. Acquires a per-agent semaphore slot
 * before running so multiple workflows can't blow past the per-agent
 * concurrency cap.
 */
export class AgentRunExecutor implements StepExecutor {
  type = "agent_run" as const;
  private runtime: AgentRuntime;
  private db: Database.Database;
  private runLoop: (prompt: string, opts: AgentLoopOptions) => Promise<string>;

  constructor(opts: AgentRunExecutorOptions) {
    this.runtime = opts.runtime;
    this.db = opts.db;
    this.runLoop = opts.runAgentLoop ?? runAgentLoop;
  }

  async execute(step: WorkflowStepDef, ctx: StepContext): Promise<StepResult> {
    const s = step as AgentRunStep;
    const agentName = String(resolveString(s.agent, ctx.scope));
    const prompt = String(resolveString(s.prompt, ctx.scope));
    const modelOverride = s.modelOverride
      ? String(resolveString(s.modelOverride, ctx.scope))
      : undefined;

    const release = await ctx.engine.acquireAgentSlot(agentName, ctx.signal, ctx.stepId);
    try {
      const sessionKey = `workflow:${ctx.runId}:${s.name}`;
      const cfg = this.runtime.getConfig();
      const agent = cfg.agents?.[agentName];
      if (!agent) throw new Error(`agent_run: agent "${agentName}" is not defined`);

      const provider = modelOverride ?? agent.provider ?? cfg.agent.defaultProvider;
      const providerCfg = cfg.providers[provider as keyof typeof cfg.providers];
      const defaultModel = providerCfg?.defaultModel ?? "";
      const model = modelOverride ?? agent.model ?? defaultModel;

      const session = newSession(this.db, model, provider, sessionKey);
      const loopOpts = this.runtime.buildLoopOptions({
        session,
        agentName,
        modelOverride,
      });
      if (s.maxToolRounds !== undefined) {
        loopOpts.maxToolRounds = s.maxToolRounds;
      }

      const response = await this.runLoop(prompt, {
        ...loopOpts,
        signal: ctx.signal,
      });
      return { output: response };
    } finally {
      release();
    }
  }
}
