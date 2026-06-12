/**
 * Default scope-creep flagger — Slice 3 step 2 of the platform vision
 * (`docs/platform-vision.md`). Subscribes to `agent.completed` and, when a
 * worktree-running agent hands the task off to another agent for review,
 * peeks at the branch commits to see whether any other `ptask_<8 hex>` ids
 * appear. When they do, writes a structured SCOPE WARNING comment on the
 * task so the reviewing agent's scope gate catches it.
 *
 * As of #204 the plugin no longer hardcodes the names "coder"/"reviewer".
 * By default it watches every worktree-opted agent
 * (`agents.<name>.worktree: true`) and fires when the final assignee is a
 * *different* configured agent — the "handed to another agent for review"
 * signal. Override via the plugin config bag:
 *   - `watchAgents: string[]`   — the dispatched agents to watch
 *   - `reviewerAssignee: string`— require this exact final assignee instead
 *     of the "any other known agent" default
 *
 * The check runs against the parent repo + branch name (not the worktree
 * dir), so it works for both preserved and cleaned-up worktrees. The
 * original watcher-internal version ran inside the worktree, which silently
 * no-opped on clean handoffs because the worktree dir was already gone.
 *
 * Users who want a different scope policy (e.g. allow paired tasks, use a
 * different commit-id pattern) disable this plugin and ship their own
 * subscriber.
 */

import type Database from "better-sqlite3";
import { addTaskComment } from "../db/task-queries.js";
import type { RuntimeEventPayload, Subscription } from "../events.js";
import type { Plugin } from "../plugin-context.js";
import type { AgentRuntime } from "../runtime.js";
import { detectScopeCreep } from "../task-watcher.js";

export interface ScopeCreepFlaggerOptions {
  runtime: AgentRuntime;
  /**
   * Dispatched agent names whose handoffs are inspected for scope creep.
   * When omitted, defaults to every worktree-opted agent
   * (`agents.<name>.worktree: true`).
   */
  watchAgents?: string[];
  /**
   * When set, only fire when the final assignee equals this exact name.
   * When omitted, fire whenever the final assignee is a *different*
   * configured agent than the one that ran (the review-handoff signal).
   */
  reviewerAssignee?: string;
}

/** Sentinel author for watcher-authored bookkeeping comments. Kept in
 *  sync with the constant in task-watcher.ts so existing tests + log
 *  queries still match. */
const SCOPE_WARNING_AUTHOR = "task-watcher";

export class ScopeCreepFlagger {
  private runtime: AgentRuntime;
  private explicitWatchAgents?: string[];
  private reviewerAssignee?: string;
  private subscription: Subscription;

  constructor(opts: ScopeCreepFlaggerOptions) {
    this.runtime = opts.runtime;
    this.explicitWatchAgents = opts.watchAgents;
    this.reviewerAssignee = opts.reviewerAssignee;
    this.subscription = this.runtime.events.on("agent.completed", (e) => this.handle(e));
  }

  stop(): void {
    this.subscription.dispose();
  }

  /** Dispatched agents to watch: explicit list when set, else worktree-opted agents. */
  private watchedAgents(): Set<string> {
    return new Set(this.explicitWatchAgents ?? this.runtime.getWorktreeAgentNames());
  }

  private async handle(e: RuntimeEventPayload<"agent.completed">): Promise<void> {
    if (!e.agentName || !this.watchedAgents().has(e.agentName)) return;
    if (e.finalTask.status !== "in_review") return;
    if (!e.worktree) return;
    const finalAssignee = e.finalTask.assignee;
    if (!finalAssignee) return;
    if (this.reviewerAssignee !== undefined) {
      // Explicit reviewer name: require an exact match.
      if (finalAssignee !== this.reviewerAssignee) return;
    } else {
      // Default: the task was handed to a *different* configured agent for
      // review. Same-agent re-assignment (or handoff to a non-agent) isn't a
      // review handoff, so don't flag scope there.
      const isKnownAgent = Boolean(this.runtime.getConfig().agents?.[finalAssignee]);
      if (!isKnownAgent || finalAssignee === e.agentName) return;
    }

    const logPrefix = `[scope-creep] [${e.taskId}]`;
    try {
      const scope = await detectScopeCreep({
        repoPath: e.worktree.repoPath,
        branch: e.worktree.branch,
        expectedTaskId: e.taskId,
      });
      if (!scope || scope.foreignTaskIds.length === 0) return;
      writeScopeWarning(this.runtime.db, e.taskId, scope.foreignTaskIds);
      console.log(
        `${logPrefix} scope warning: branch has commits for foreign task(s) ${scope.foreignTaskIds.join(",")}`,
      );
    } catch (err) {
      console.warn(`${logPrefix} scope-creep check failed:`, (err as Error).message);
    }
  }
}

/**
 * Render the SCOPE WARNING comment. Exported so tests can pin the
 * shape; a reviewing agent's scope gate can grep `SCOPE WARNING:` as its
 * trigger, so renaming the leading token would break that gate.
 */
export function writeScopeWarning(db: Database.Database, taskId: string, foreignTaskIds: string[]): void {
  addTaskComment(db, taskId, {
    author: SCOPE_WARNING_AUTHOR,
    content: [
      `SCOPE WARNING: branch contains commits for ${foreignTaskIds.length} other task(s): ${foreignTaskIds.join(", ")}.`,
      "",
      "Reviewer: apply the scope gate — these commits should",
      "be on separate branches. Request changes with 'split into",
      "separate task' unless the foreign work is genuinely required",
      "for this task to compile/run.",
    ].join("\n"),
  });
}

/**
 * Default-plugin entry point — loaded via `config.plugins:
 * builtin:scope-creep-flagger`. Binds a {@link ScopeCreepFlagger} to the
 * live runtime and returns a disposer.
 *
 * Reads optional `watchAgents: string[]` and `reviewerAssignee: string`
 * from `ctx.config`
 * (`{ module: "builtin:scope-creep-flagger", config: { watchAgents: [...], reviewerAssignee: "reviewer" } }`).
 * When absent, the flagger watches every worktree-opted agent and fires on
 * any handoff to a different configured agent.
 */
const plugin: Plugin = (ctx) => {
  if (!ctx.runtime) return;
  const rawAgents = ctx.config.watchAgents;
  const watchAgents =
    Array.isArray(rawAgents) && rawAgents.every((x) => typeof x === "string") ? (rawAgents as string[]) : undefined;
  const reviewerAssignee = typeof ctx.config.reviewerAssignee === "string" ? ctx.config.reviewerAssignee : undefined;
  const flagger = new ScopeCreepFlagger({ runtime: ctx.runtime, watchAgents, reviewerAssignee });
  return () => flagger.stop();
};
export default plugin;
