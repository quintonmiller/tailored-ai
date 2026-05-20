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
      // Registry first (S11.4 agents-as-resources), then fall back to
      // config.yaml — same precedence resolveAgent uses everywhere else.
      const agent =
        this.runtime.getAgentRegistry().get(agentName) ?? cfg.agents?.[agentName];
      if (!agent) {
        const known = [
          ...this.runtime.getAgentRegistry().list().map((r) => r.id),
          ...Object.keys(cfg.agents ?? {}),
        ];
        const unique = Array.from(new Set(known)).sort();
        throw new Error(
          `agent_run: agent "${agentName}" is not defined. Known agents: ${unique.join(", ") || "(none)"}`,
        );
      }

      const provider = modelOverride ?? agent.provider ?? cfg.agent.defaultProvider;
      const providerCfg = cfg.providers[provider as keyof typeof cfg.providers];
      const defaultModel = providerCfg?.defaultModel ?? "";
      const model = modelOverride ?? agent.model ?? defaultModel;

      const session = newSession(this.db, model, provider, sessionKey);
      // When the agent_run is nested inside a worktree step, the worktree
      // executor sets `scope.vars.worktree`. Pass that through as a synthetic
      // project context so the agent loop's cwd lands inside the worktree
      // rather than the repo root.
      const worktree = (ctx.scope.vars?.worktree ?? null) as { path?: string } | null;
      const projectOverride = worktree?.path
        ? {
            id: `worktree:${ctx.runId}:${s.name}`,
            name: `worktree-${s.name}`,
            path: worktree.path,
            overlayPath: worktree.path,
            overlay: {},
          }
        : undefined;
      const loopOpts = this.runtime.buildLoopOptions({
        session,
        agentName,
        modelOverride,
        ...(projectOverride ? { project: projectOverride } : {}),
      });
      if (s.maxToolRounds !== undefined) {
        loopOpts.maxToolRounds = s.maxToolRounds;
      }

      const response = await this.runLoop(prompt, {
        ...loopOpts,
        signal: ctx.signal,
      });
      if (s.parseAs === "json") {
        return { output: parseJsonResponse(response, s.name) };
      }
      return { output: response };
    } finally {
      release();
    }
  }
}

/**
 * Pulls a JSON value out of an agent's free-form text response. Tries, in
 * order: the whole string trimmed, a ```json fenced block, the first
 * `[...]` span, the first `{...}` span. Throws with a useful preview if
 * nothing parses — that's a real workflow bug worth surfacing.
 */
function parseJsonResponse(text: string, stepName: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  const candidates: string[] = [trimmed];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1].trim());
  const arr = trimmed.match(/\[[\s\S]*\]/);
  if (arr) candidates.push(arr[0]);
  const obj = trimmed.match(/\{[\s\S]*\}/);
  if (obj) candidates.push(obj[0]);

  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // try next
    }
  }
  const preview = trimmed.slice(0, 200);
  throw new Error(
    `agent_run "${stepName}": parseAs=json failed — response was not JSON. Preview: ${preview}`,
  );
}
