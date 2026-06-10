/**
 * Default stall guard — Slice 3 step 3 of the platform vision
 * (`docs/platform-vision.md`). Subscribes to `agent.stalled` (which the
 * watcher emits instead of `agent.completed` when the agent loop
 * returns a `[Agent stopped: …]` terminator) and decides whether to
 * retry the dispatch or transition the task to blocked.
 *
 * - **Retry path** (under the configured cap): writes a `STALL #N`
 *   comment summarising what happened plus any preserved worktree
 *   state, then emits `task.dispatch_requested` so the watcher
 *   re-fires routing with the same assignee.
 * - **Block path** (out of retries): writes a decompose-this-task
 *   comment, transitions the task to blocked, then re-emits the
 *   payload as `agent.completed` so the Discord notifier (and any
 *   other subscriber that watches completions) sees the terminal
 *   transition.
 *
 * Users who want a different retry policy disable this plugin and
 * ship their own subscriber to `agent.stalled`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import { addTaskComment, updateProjectTask } from "../db/task-queries.js";
import type { RuntimeEventPayload, Subscription } from "../events.js";
import type { Plugin } from "../plugin-context.js";
import type { AgentRuntime } from "../runtime.js";
import { STALL_COMMENT_PREFIX } from "../task-watcher.js";

const exec = promisify(execFile);

/** Sentinel author for stall-guard comments. Kept in sync with the
 *  watcher's bookkeeping author so existing log queries + tests still
 *  match (`task-watcher` is what they grep for). */
const STALL_GUARD_AUTHOR = "task-watcher";

export interface StallGuardOptions {
  runtime: AgentRuntime;
  /** Override the retry cap from config. Mainly for tests. */
  maxStallRetries?: number;
}

export class StallGuard {
  private runtime: AgentRuntime;
  private subscription: Subscription;
  private overrideMaxRetries?: number;

  constructor(opts: StallGuardOptions) {
    this.runtime = opts.runtime;
    this.overrideMaxRetries = opts.maxStallRetries;
    this.subscription = this.runtime.events.on("agent.stalled", (e) => this.handle(e));
  }

  stop(): void {
    this.subscription.dispose();
  }

  private async handle(e: RuntimeEventPayload<"agent.stalled">): Promise<void> {
    const logPrefix = `[stall-guard] [${e.taskId}]`;
    const taskId = e.taskId;

    const priorAttempt = countPriorStalls(this.runtime.db, taskId);
    const attempt = priorAttempt + 1;

    const preservedPath = e.worktree?.preservedPath ?? null;
    const worktreeStatus = preservedPath ? await summarizeWorktreeChanges(preservedPath) : null;
    const stallComment = formatStallComment(attempt, e.stallReason, preservedPath, worktreeStatus);
    addTaskComment(this.runtime.db, taskId, { author: STALL_GUARD_AUTHOR, content: stallComment });

    const maxRetries = this.overrideMaxRetries ?? this.runtime.getConfig().taskWatcher?.maxStallRetries ?? 1;
    if (attempt <= maxRetries) {
      console.log(`${logPrefix} stall detected (#${attempt}) — requesting retry`);
      // Small delay lets the user-facing comment land before we re-fire.
      // Mirrors the original watcher delay so the comment timeline stays
      // chronological in the UI.
      setTimeout(() => {
        this.runtime.events.emit("task.dispatch_requested", {
          taskId,
          projectId: e.projectId,
          reason: `stall retry #${attempt}: ${e.stallReason}`,
        });
      }, 500);
      return;
    }

    // Out of retries: transition to blocked AND leave a decomposition
    // hint. A task that stalls twice is almost always too big for one
    // coder pass — splitting it is the right next step.
    console.log(`${logPrefix} stall detected (#${attempt}) — out of retries, transitioning to blocked`);
    addTaskComment(this.runtime.db, taskId, {
      author: STALL_GUARD_AUTHOR,
      content: DECOMPOSE_HINT,
    });
    updateProjectTask(this.runtime.db, taskId, {
      status: "blocked",
      blocked_reason: `coder-stalled after ${attempt} attempts (suggest decomposition): ${e.stallReason}`,
    });

    // Re-emit as agent.completed with the new finalTask so the Discord
    // notifier and other completion subscribers see the terminal state.
    // Stall guard subscribes to agent.stalled, so this won't loop.
    this.runtime.events.emit("agent.completed", {
      taskId: e.taskId,
      projectId: e.projectId,
      agentName: e.agentName,
      action: e.action,
      task: e.task,
      finalTask: { ...e.finalTask, status: "blocked" },
      response: e.response,
      worktree: e.worktree,
    });
  }
}

/** Count prior `STALL #N` comments on a task and return the highest N. */
export function countPriorStalls(db: Database.Database, taskId: string): number {
  const rows = db
    .prepare("SELECT content FROM task_comments WHERE task_id = ? AND author = ? AND content LIKE ?")
    .all(taskId, STALL_GUARD_AUTHOR, `${STALL_COMMENT_PREFIX}%`) as { content: string }[];
  return rows
    .map((r) => {
      const m = r.content.match(/^STALL #(\d+)/);
      return m ? Number.parseInt(m[1], 10) : 0;
    })
    .reduce((a, b) => (a > b ? a : b), 0);
}

/**
 * Renders the structured stall comment. Format is `STALL #N: <reason>`
 * so subsequent stalls can count priors with a simple LIKE query.
 * Exported so tests can pin the shape and external implementations can
 * match it.
 */
export function formatStallComment(
  attempt: number,
  stallReason: string,
  worktreePath: string | null,
  worktreeStatus: { stat: string; status: string } | null,
): string {
  const lines: string[] = [];
  lines.push(`${STALL_COMMENT_PREFIX}${attempt}: ${stallReason}`);
  if (worktreePath) {
    lines.push(`Worktree preserved at: ${worktreePath}`);
  }
  if (worktreeStatus?.status?.trim()) {
    lines.push("");
    lines.push("Uncommitted changes (git status --short):");
    lines.push("```");
    lines.push(worktreeStatus.status.trim());
    lines.push("```");
  }
  if (worktreeStatus?.stat?.trim()) {
    lines.push("");
    lines.push("Diff stat vs HEAD:");
    lines.push("```");
    lines.push(worktreeStatus.stat.trim());
    lines.push("```");
  }
  if (!worktreeStatus || (!worktreeStatus.status?.trim() && !worktreeStatus.stat?.trim())) {
    lines.push("");
    lines.push("No file changes were made before the loop ended.");
  }
  return lines.join("\n");
}

/** `git status --short` + `git diff --stat HEAD` in the preserved worktree, if any. */
async function summarizeWorktreeChanges(worktreePath: string): Promise<{ stat: string; status: string } | null> {
  try {
    const [status, stat] = await Promise.all([
      exec("git", ["-C", worktreePath, "status", "--short"])
        .then((r) => r.stdout)
        .catch(() => ""),
      exec("git", ["-C", worktreePath, "diff", "--stat", "HEAD"])
        .then((r) => r.stdout)
        .catch(() => ""),
    ]);
    return { status, stat };
  } catch {
    return null;
  }
}

const DECOMPOSE_HINT = [
  "**Two stalls in a row — this task is likely too large for one coder pass.**",
  "",
  "Suggested next move for the supervisor (or user):",
  "1. Read the worktree (if preserved) to see what got done.",
  "2. Split this task into 2–3 smaller subtasks with concrete file lists",
  '   (e.g. "add the schema migration", "wire the API endpoint",',
  '   "add the UI"). Each subtask should be doable in ~15 tool calls.',
  "3. Mark each subtask `assignee=coder`; the supervisor's job is then",
  "   to merge them back together.",
  "",
  "Do NOT just re-dispatch this task as-is — it will stall again.",
].join("\n");

/**
 * Default-plugin entry point — loaded via `config.plugins:
 * builtin:stall-guard`. Binds a {@link StallGuard} to the live runtime and
 * returns a disposer.
 *
 * Reads an optional numeric `maxStallRetries` from `ctx.config`
 * (`{ module: "builtin:stall-guard", config: { maxStallRetries: 3 } }`),
 * which overrides `taskWatcher.maxStallRetries`. When absent, the guard
 * falls back to that config value as before.
 */
const plugin: Plugin = (ctx) => {
  if (!ctx.runtime) return;
  const raw = ctx.config.maxStallRetries;
  const maxStallRetries = typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
  const guard = new StallGuard({ runtime: ctx.runtime, maxStallRetries });
  return () => guard.stop();
};
export default plugin;
