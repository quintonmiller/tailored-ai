/**
 * Default coder/reviewer project-id guardrail — Slice 3 step 4 of the
 * platform vision (`docs/platform-vision.md`). Subscribes to
 * `agent.dispatched` (emitted via `bus.emitAsync` for vetoable
 * causality) and refuses the dispatch when a coder or reviewer agent
 * is about to run without a usable project path.
 *
 * Why this matters: a coder dispatched without `project_id` runs
 * unisolated in the main checkout and commits straight to main. The
 * watcher originally inlined this guard as a hard return at the top of
 * `processEvent`. Moving it here keeps the same guarantee while making
 * the policy replaceable — a user with a different isolation model
 * (per-repo dispatch, container-only, no git at all) disables this
 * plugin and ships their own subscriber.
 *
 * On veto the plugin also writes a BLOCKED comment + transitions the
 * task to `blocked` so the next agent / user sees what to fix.
 */

import { getProject } from "../db/project-queries.js";
import { addTaskComment, updateProjectTask } from "../db/task-queries.js";
import type { RuntimeEventPayload, Subscription } from "../events.js";
import type { AgentRuntime } from "../runtime.js";

/** Author for guard-authored bookkeeping comments. Same sentinel the
 *  watcher uses so existing UI / log filtering keeps working. */
const GUARD_AUTHOR = "task-watcher";

export interface CoderProjectGuardOptions {
  runtime: AgentRuntime;
}

export class CoderProjectGuard {
  private runtime: AgentRuntime;
  private subscription: Subscription;

  constructor(opts: CoderProjectGuardOptions) {
    this.runtime = opts.runtime;
    this.subscription = this.runtime.events.on("agent.dispatched", (e) => this.handle(e));
  }

  stop(): void {
    this.subscription.dispose();
  }

  private handle(e: RuntimeEventPayload<"agent.dispatched">): boolean {
    if (e.agentName !== "coder" && e.agentName !== "reviewer") return true;

    const logPrefix = `[coder-project-guard] [${e.taskId}]`;

    if (!e.projectId) {
      const reason =
        `coder/reviewer dispatch refused: task has no project_id. ` +
        `Assign the task to a project whose path points at a git repo before re-routing.`;
      console.error(`${logPrefix} ${reason}`);
      this.blockTask(e.taskId, reason, "no project_id — coder/reviewer needs an isolated worktree");
      return false;
    }

    const project = getProject(this.runtime.db, e.projectId);
    if (!project?.path) {
      const reason =
        `coder/reviewer dispatch refused: project "${project?.title ?? e.projectId}" ` +
        `has no path. Set the project's path to a git repo (or move the task to a project that has one) ` +
        `before re-routing.`;
      console.error(`${logPrefix} ${reason}`);
      this.blockTask(e.taskId, reason, "project has no path — coder/reviewer needs an isolated worktree");
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
