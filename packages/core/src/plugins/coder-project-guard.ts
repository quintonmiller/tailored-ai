/**
 * Default project-id guardrail for worktree-opted agents — Slice 3 step 4
 * of the platform vision (`docs/platform-vision.md`). Subscribes to
 * `agent.dispatched` (emitted via `bus.emitAsync` for vetoable causality)
 * and refuses the dispatch when an agent that runs in an isolated worktree
 * is about to run without a usable project path.
 *
 * Historically this keyed on the hardcoded names "coder"/"reviewer"; as of
 * #204 it watches the set of agents that opt into worktrees
 * (`agents.<name>.worktree: true`), or an explicit `agents` list from the
 * plugin's own config bag. The plugin id stays `builtin:coder-project-guard`
 * for config compatibility even though it's no longer coder-specific.
 *
 * Why this matters: an isolated agent dispatched without `project_id` runs
 * unisolated in the main checkout and commits straight to main. The watcher
 * originally inlined this guard as a hard return at the top of
 * `processEvent`. Moving it here keeps the same guarantee while making the
 * policy replaceable — a user with a different isolation model (per-repo
 * dispatch, container-only, no git at all) disables this plugin and ships
 * their own subscriber.
 *
 * On veto the plugin also writes a BLOCKED comment + transitions the task
 * to `blocked` so the next agent / user sees what to fix.
 */

import { getProject } from "../db/project-queries.js";
import { addTaskComment, updateProjectTask } from "../db/task-queries.js";
import type { RuntimeEventPayload, Subscription } from "../events.js";
import type { Plugin, PluginMeta } from "../plugin-context.js";
import type { AgentRuntime } from "../runtime.js";

/** Author for guard-authored bookkeeping comments. Same sentinel the
 *  watcher uses so existing UI / log filtering keeps working. */
const GUARD_AUTHOR = "task-watcher";

export interface CoderProjectGuardOptions {
  runtime: AgentRuntime;
  /**
   * Agent names this guard applies to. When omitted, the guard watches
   * every agent that opts into an isolated worktree
   * (`agents.<name>.worktree: true`) — these are the dispatches that need a
   * project path. Set explicitly to override that default.
   */
  agents?: string[];
}

export class CoderProjectGuard {
  private runtime: AgentRuntime;
  private explicitAgents?: string[];
  private subscription: Subscription;

  constructor(opts: CoderProjectGuardOptions) {
    this.runtime = opts.runtime;
    this.explicitAgents = opts.agents;
    this.subscription = this.runtime.events.on("agent.dispatched", (e) => this.handle(e));
  }

  stop(): void {
    this.subscription.dispose();
  }

  /** The set of agent names this guard guards: the explicit list when set,
   *  else every worktree-opted agent in config. */
  private guardedAgents(): Set<string> {
    return new Set(this.explicitAgents ?? this.runtime.getWorktreeAgentNames());
  }

  private handle(e: RuntimeEventPayload<"agent.dispatched">): boolean {
    if (!e.agentName || !this.guardedAgents().has(e.agentName)) return true;

    const logPrefix = `[coder-project-guard] [${e.taskId}]`;

    if (!e.projectId) {
      const reason =
        `${e.agentName} dispatch refused: task has no project_id. ` +
        `Assign the task to a project whose path points at a git repo before re-routing.`;
      console.error(`${logPrefix} ${reason}`);
      this.blockTask(e.taskId, reason, "no project_id — worktree agent needs an isolated checkout");
      return false;
    }

    const project = getProject(this.runtime.db, e.projectId);
    if (!project?.path) {
      const reason =
        `${e.agentName} dispatch refused: project "${project?.title ?? e.projectId}" ` +
        `has no path. Set the project's path to a git repo (or move the task to a project that has one) ` +
        `before re-routing.`;
      console.error(`${logPrefix} ${reason}`);
      this.blockTask(e.taskId, reason, "project has no path — worktree agent needs an isolated checkout");
      return false;
    }

    return true;
  }

  private blockTask(taskId: string, reason: string, blockedReason: string): void {
    addTaskComment(this.runtime.db, taskId, {
      author: GUARD_AUTHOR,
      content: `BLOCKED: ${reason}`,
    });
    updateProjectTask(this.runtime.db, taskId, {
      status: "blocked",
      blocked_reason: blockedReason,
    });
  }
}

/**
 * Default-plugin entry point — loaded via `config.plugins:
 * builtin:coder-project-guard` (id kept for back-compat; see file header).
 * Binds a {@link CoderProjectGuard} to the live runtime and returns a
 * disposer.
 *
 * Reads an optional `agents: string[]` from `ctx.config`
 * (`{ module: "builtin:coder-project-guard", config: { agents: [...] } }`)
 * to override which agents are guarded. When absent, the guard defaults to
 * every agent with `worktree: true`.
 */
const plugin: Plugin = (ctx) => {
  if (!ctx.runtime) return;
  const raw = ctx.config.agents;
  const agents = Array.isArray(raw) && raw.every((x) => typeof x === "string") ? (raw as string[]) : undefined;
  const guard = new CoderProjectGuard({ runtime: ctx.runtime, agents });
  return () => guard.stop();
};
export const meta: PluginMeta = {
  name: "Coder project guard",
  description:
    "Refuses dispatching worktree-opted agents without a usable project path (subscribes to agent.dispatched).",
  registers: [{ kind: "eventSubscriber", id: "coder-project-guard" }],
};

export default plugin;
