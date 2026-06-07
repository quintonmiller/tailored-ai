/**
 * Default scope-creep flagger — Slice 3 step 2 of the platform vision
 * (`docs/platform-vision.md`). Subscribes to `agent.completed` and,
 * when the coder hands off to the reviewer, peeks at the branch
 * commits to see whether any other `ptask_<8 hex>` ids appear. When
 * they do, writes a structured SCOPE WARNING comment on the task so
 * the reviewer's GATE 3 catches it.
 *
 * The check runs against the parent repo + branch name (not the
 * worktree dir), so it works for both preserved and cleaned-up
 * worktrees. The original watcher-internal version ran inside the
 * worktree, which silently no-opped on clean coder→reviewer handoffs
 * because the worktree dir was already gone — fixed by this PR.
 *
 * Users who want a different scope policy (e.g. allow paired tasks,
 * use a different commit-id pattern) disable this plugin and ship
 * their own subscriber.
 */

import type Database from "better-sqlite3";
import { addTaskComment } from "../db/task-queries.js";
import type { RuntimeEventPayload, Subscription } from "../events.js";
import type { AgentRuntime } from "../runtime.js";
import { detectScopeCreep } from "../task-watcher.js";

export interface ScopeCreepFlaggerOptions {
  runtime: AgentRuntime;
}

/** Sentinel author for watcher-authored bookkeeping comments. Kept in
 *  sync with the constant in task-watcher.ts so existing tests + log
 *  queries still match. */
const SCOPE_WARNING_AUTHOR = "task-watcher";

export class ScopeCreepFlagger {
  private runtime: AgentRuntime;
  private subscription: Subscription;

  constructor(opts: ScopeCreepFlaggerOptions) {
    this.runtime = opts.runtime;
    this.subscription = this.runtime.events.on("agent.completed", (e) => this.handle(e));
  }

  stop(): void {
    this.subscription.dispose();
  }

  private async handle(e: RuntimeEventPayload<"agent.completed">): Promise<void> {
    if (e.agentName !== "coder") return;
    if (e.finalTask.assignee !== "reviewer") return;
    if (e.finalTask.status !== "in_review") return;
    if (!e.worktree) return;

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
 * shape; the reviewer agent's GATE 3 grep matches `SCOPE WARNING:` as
 * its trigger, so renaming the leading token would break that gate.
 */
export function writeScopeWarning(db: Database.Database, taskId: string, foreignTaskIds: string[]): void {
  addTaskComment(db, taskId, {
    author: SCOPE_WARNING_AUTHOR,
    content: [
      `SCOPE WARNING: branch contains commits for ${foreignTaskIds.length} other task(s): ${foreignTaskIds.join(", ")}.`,
      "",
      "Reviewer: apply GATE 3 (scope check) — these commits should",
      "be on separate branches. Request changes with 'split into",
      "separate task' unless the foreign work is genuinely required",
      "for this task to compile/run.",
    ].join("\n"),
  });
}
