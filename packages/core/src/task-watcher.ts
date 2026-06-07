import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveAgent } from "./agent/agents.js";
import { executeHooks } from "./agent/hooks.js";
import { runAgentLoop } from "./agent/loop.js";
import { findOrCreateSession, resetSession } from "./agent/session.js";
import { getProject } from "./db/project-queries.js";
import { addTaskComment, type ProjectTask, updateProjectTask } from "./db/task-queries.js";
import { expandPrompt } from "./prompts/expand.js";
import type { AgentRuntime } from "./runtime.js";
import { createWorktree, type Worktree } from "./worktree.js";

const exec = promisify(execFile);

/** Sentinel author for watcher-authored bookkeeping comments. */
const WATCHER_COMMENT_AUTHOR = "task-watcher";

/** Stall-comment prefix kept here so the StallGuard plugin and any
 *  external implementation share one constant. */
export const STALL_COMMENT_PREFIX = "STALL #";

export interface TaskEvent {
  action: "created" | "updated" | "commented";
  task: ProjectTask;
}

export interface TaskWatcherOptions {
  runtime: AgentRuntime;
}

export class TaskWatcher {
  private runtime: AgentRuntime;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private queue: Promise<void> = Promise.resolve();
  /**
   * Per-task assignee we last fired the watcher with. Used to gate
   * `updated` events: we only re-fire when the assignee actually changes
   * to a (different) known agent — prevents the coder→in_review→watcher
   * → coder loop, but allows coder→reviewer and reviewer→coder handoffs
   * (Phase 6, multi-agent review loop).
   */
  private lastFiredAssignee = new Map<string, string | null>();
  /**
   * Subscription to `task.dispatch_requested`. Default StallGuard plugin
   * emits this when it wants a retry; any other plugin can do the same
   * to ask the watcher to re-fire routing.
   */
  private dispatchRequestSub: import("./events.js").Subscription;

  constructor(opts: TaskWatcherOptions) {
    this.runtime = opts.runtime;
    this.dispatchRequestSub = this.runtime.events.on("task.dispatch_requested", (e) => this.handleDispatchRequest(e));
  }

  /**
   * Wire-back from a `task.dispatch_requested` event. Re-routes the task
   * through `notify({...}, { force: true })` so the assignee-transition
   * gate is bypassed (the requesting plugin already knows it wants the
   * same agent to run again — typically StallGuard retrying a stall).
   */
  private handleDispatchRequest(e: import("./events.js").RuntimeEventPayload<"task.dispatch_requested">): void {
    // Best-effort: drop the request if we can't find the task. The plugin
    // logged a reason already, no need to double-warn.
    const row = this.runtime.db.prepare("SELECT * FROM project_tasks WHERE id = ?").get(e.taskId) as
      | ProjectTask
      | undefined;
    if (!row) return;
    let tags: string[] = [];
    try {
      tags = JSON.parse((row as unknown as { tags: string }).tags) ?? [];
    } catch {
      tags = [];
    }
    console.log(`[task-watcher] [${e.taskId}] dispatch requested: ${e.reason}`);
    this.notify({ action: "updated", task: { ...row, tags } as ProjectTask }, { force: true });
  }

  /**
   * Convenience: notify by id. Looks up the current task and forwards to
   * notify(). Used by the tasks tool (which has the id at mutation time
   * but not the full row). Silently no-ops if the task is gone.
   *
   * `projectId` carries the routing key when the task lives on a per-project
   * backend (PR #123). Without it the lookup falls back to the default
   * backend, which silently misses GitHub-issue tasks (gh-* ids never
   * appear in project_tasks). With it, the runtime's per-project resolver
   * fetches from the right backend.
   */
  notifyById(action: TaskEvent["action"], taskId: string, projectId?: string): void {
    if (projectId) {
      // Per-project lookup: backend.get is async. Fire the notify when it
      // resolves; swallow errors so a flaky GH API call doesn't break the
      // watcher.
      void this.runtime
        .getTaskBackendForProject(projectId)
        .get(taskId)
        .then((task) => {
          if (!task) return;
          // The Task interface from the backend is structurally compatible
          // with ProjectTask for the fields the watcher reads (id, title,
          // assignee, tags, status, etc.). project_id on the backend Task
          // is null for GH (issues don't carry our project_id); inject the
          // routing key so downstream resolution (worktree path, etc.)
          // finds it.
          const projectTask = { ...task, project_id: projectId } as ProjectTask;
          this.notify({ action, task: projectTask });
        })
        .catch((err) => {
          console.warn(`[task-watcher] notifyById ${taskId} via project ${projectId} failed:`, (err as Error).message);
        });
      return;
    }

    // Default backend: keep the original synchronous SQL path. Faster than
    // going through the backend resolver for the common case and avoids
    // touching the existing test surface.
    const row = this.runtime.db.prepare("SELECT * FROM project_tasks WHERE id = ?").get(taskId) as
      | ProjectTask
      | undefined;
    if (!row) return;
    // tags is stored as JSON; parse it for the event.
    let tags: string[] = [];
    try {
      const raw = (row as unknown as { tags: string }).tags;
      tags = raw ? JSON.parse(raw) : [];
    } catch {
      tags = [];
    }
    this.notify({ action, task: { ...row, tags } as ProjectTask });
  }

  notify(event: TaskEvent, opts: { force?: boolean } = {}): void {
    const config = this.runtime.getConfig().taskWatcher;
    if (!config.enabled) return;
    if (!config.triggers.includes(event.action)) return;

    const taskId = event.task.id;
    const newAssignee = event.task.assignee?.trim() || null;

    // `updated` events fire only when the assignee transitions to a
    // different known agent. Without this gate, every comment / status
    // bump re-triggers the same agent that just finished, looping.
    // `created` events always fire (initial routing).
    // `force` bypasses the gate — used for stall retries + the stuck-task
    // scanner, where we explicitly want to re-fire on the same assignee.
    if (event.action === "updated" && !opts.force) {
      const lastFired = this.lastFiredAssignee.get(taskId);
      const isKnownAgent = newAssignee !== null && Boolean(this.runtime.getConfig().agents?.[newAssignee]);
      if (!isKnownAgent || newAssignee === lastFired) {
        return;
      }
    }

    // Clear existing debounce for this task
    const existing = this.debounceTimers.get(taskId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(taskId);
      this.lastFiredAssignee.set(taskId, newAssignee);
      this.enqueue(event);
    }, config.debounceMs);

    this.debounceTimers.set(taskId, timer);
  }

  private enqueue(event: TaskEvent): void {
    this.queue = this.queue
      .then(() => this.processEvent(event))
      .catch((err) => {
        console.error(`[task-watcher] Error processing event for ${event.task.id}:`, err);
      });
  }

  private async processEvent(event: TaskEvent): Promise<void> {
    const config = this.runtime.getConfig().taskWatcher;
    if (!config.enabled) return;

    const logPrefix = `[task-watcher] [${event.task.id}]`;
    console.log(`${logPrefix} Processing ${event.action} event`);

    // Route by assignee when it names a defined agent. This is what
    // makes assignee="coder" actually invoke the coder agent rather than
    // the default triage one (docs/agent-unification.md, Phase 5).
    // Fallback chain: task.assignee (if it resolves) → config.taskWatcher.agent → undefined.
    const config_ = this.runtime.getConfig();
    const assignee = event.task.assignee?.trim() || undefined;
    const assigneeIsAgent = assignee !== undefined && Boolean(config_.agents?.[assignee]);
    const agentName = assigneeIsAgent ? assignee : (config.agent ?? config.profile);
    if (assigneeIsAgent) {
      console.log(`${logPrefix} routing to assignee agent "${agentName}"`);
    }

    // Hard guard rail (added after the main-pollution incident).
    // Coder/reviewer dispatches without a usable project path would
    // run unisolated in the main checkout and commit to main. Refuse
    // the dispatch — mark blocked so the user / default agent fixes
    // the project assignment before re-routing. Runs BEFORE resolveAgent
    // / session setup so the failure mode is cheap and obvious.
    const isCodingAgent = agentName === "coder" || agentName === "reviewer";
    if (isCodingAgent && !event.task.project_id) {
      const reason =
        `coder/reviewer dispatch refused: task has no project_id. ` +
        `Assign the task to a project whose path points at a git repo before re-routing.`;
      console.error(`${logPrefix} ${reason}`);
      addTaskComment(this.runtime.db, event.task.id, {
        author: WATCHER_COMMENT_AUTHOR,
        content: `BLOCKED: ${reason}`,
      });
      updateProjectTask(this.runtime.db, event.task.id, {
        status: "blocked",
        blocked_reason: "no project_id — coder/reviewer needs an isolated worktree",
      });
      return;
    }
    if (isCodingAgent && event.task.project_id) {
      const project = getProject(this.runtime.db, event.task.project_id);
      if (!project?.path) {
        const reason =
          `coder/reviewer dispatch refused: project "${project?.title ?? event.task.project_id}" ` +
          `has no path. Set the project's path to a git repo (or move the task to a project that has one) ` +
          `before re-routing.`;
        console.error(`${logPrefix} ${reason}`);
        addTaskComment(this.runtime.db, event.task.id, {
          author: WATCHER_COMMENT_AUTHOR,
          content: `BLOCKED: ${reason}`,
        });
        updateProjectTask(this.runtime.db, event.task.id, {
          status: "blocked",
          blocked_reason: "project has no path — coder/reviewer needs an isolated worktree",
        });
        return;
      }
    }

    const resolved = resolveAgent(
      agentName,
      this.runtime.getConfig(),
      this.runtime.getTools(),
      undefined,
      this.runtime.contextDir,
    );

    const templateVars: Record<string, string> = {
      action: event.action,
      task_id: event.task.id,
      task_title: event.task.title,
      task_status: event.task.status,
      task_description: event.task.description ?? "",
      task_author: event.task.author ?? "",
      task_tags: (event.task.tags ?? []).join(", "),
    };

    // Session follows the agent: agent set → dedicated session (reset each event),
    // no agent → primary session (shared with the Discord owner's conversation).
    const ownerId = this.runtime.getConfig().channels.discord?.owner;
    const session = agentName
      ? resetSession(this.runtime.db, `task-watcher:${agentName}`, resolved.model, resolved.provider)
      : findOrCreateSession(
          this.runtime.db,
          this.runtime.makeSessionKey({ channelId: "discord", userId: ownerId ?? "owner" }),
          resolved.model,
          resolved.provider,
        );

    // Resolve hooks
    const hooks = this.runtime.resolveHooks({ agentName, overrideHooks: config.hooks });
    const allTools = this.runtime.getTools();

    const promptsConfig = this.runtime.getConfig().prompts;

    // --- beforeRun hooks ---
    if (hooks.beforeRun.length > 0) {
      const { skipped } = await executeHooks(
        hooks.beforeRun,
        allTools,
        templateVars,
        session.id,
        logPrefix,
        promptsConfig,
      );
      if (skipped) {
        console.log(`${logPrefix} Skipped by beforeRun hook`);
        return;
      }
    }

    // Worktree pre-flight for coder/reviewer agents (Phase 5+6).
    // Both work on a per-task branch — coder writes; reviewer inspects
    // diffs and runs tests. After the loop finishes, the worktree is
    // cleaned up but the branch is retained so future iterations
    // (e.g. reviewer requests changes → coder re-runs) pick up the
    // existing branch instead of starting fresh.
    let worktree: Worktree | undefined;
    /**
     * Parent repo for the worktree we'll create below — captured at top
     * scope so it survives the worktree.cleanup() in the finally block
     * and can be attached to agent.completed. Plugin-side git inspection
     * (scope-creep flagger, etc.) keys off the parent repo + branch
     * because the worktree dir may be gone by event time.
     */
    let worktreeRepoPath: string | undefined;
    let projectOverride: import("./projects/resolve.js").ProjectContext | undefined;
    // The guard rail at the top of processEvent has already refused
    // dispatches that would lack an isolated worktree, so by this
    // point a coding agent always has a project_id + project.path.
    const needsWorktree = isCodingAgent && event.task.project_id;
    if (needsWorktree) {
      const project = getProject(this.runtime.db, event.task.project_id!);
      const repoPath = project?.path;
      if (!repoPath) {
        // Unreachable now (handled by the guard above), but keep the
        // log line so any future regression surfaces clearly.
        console.error(
          `${logPrefix} ${agentName} routed but project ${event.task.project_id} has no path — skipping worktree`,
        );
      } else {
        const slug = slugify(event.task.title).slice(0, 30) || "task";
        const branch = `agent/${event.task.id}-${slug}`;
        try {
          worktree = await createWorktree({
            repoDir: repoPath,
            strategy: { type: "branch", branch },
          });
          worktreeRepoPath = repoPath;
          projectOverride = {
            id: project!.id,
            name: project!.title,
            path: worktree.path,
            overlayPath: project!.config_overlay_path ?? "",
            overlay: {},
          };
          console.log(`${logPrefix} created worktree at ${worktree.path} on ${branch}`);
          // pnpm symlinks the workspace deps from the central store
          // into the worktree's node_modules — fast (~3s with cache).
          // Without this the coder can't run pnpm test / typecheck.
          try {
            const { exec } = await import("node:child_process");
            await new Promise<void>((res, rej) => {
              exec("pnpm install --prefer-offline --silent", { cwd: worktree!.path }, (err) => {
                if (err) rej(err);
                else res();
              });
            });
            console.log(`${logPrefix} pnpm install complete in worktree`);
          } catch (err) {
            console.warn(`${logPrefix} pnpm install in worktree failed:`, (err as Error).message);
            // Non-fatal — agent may not need to run tests.
          }
        } catch (err) {
          console.error(`${logPrefix} worktree creation failed:`, (err as Error).message);
          // Continue without isolation — agent runs in the project's main checkout.
        }
      }
    }

    // Build prompt: structured task context + user-configured prompt.
    // Coder/reviewer routes get role-specific preambles that explain the
    // worktree + branch + per-role lifecycle.
    const configPrompt = await expandPrompt(config.prompt, templateVars, promptsConfig);
    const ownerName = this.runtime.getConfig().channels.discord?.owner ?? "the user";
    let rolePreamble = "";
    if (agentName === "coder" && worktree) {
      rolePreamble = [
        "You are the **coder** agent. A git worktree has been set up for you:",
        `- Worktree path (host): ${worktree.path}`,
        `- Branch: ${worktree.branch}`,
        "- Status: checked out (may have prior commits if this is an iteration)",
        "",
        "**Execution environment**: your tool calls run inside a Docker",
        "container. The worktree above is bind-mounted at `/work` inside",
        "the container. Use **relative paths** in tool calls (e.g.",
        "`packages/core/src/foo.ts`), or absolute paths under `/work`",
        "(e.g. `/work/packages/core/src/foo.ts`). Absolute paths that",
        "point at the host repo outside the worktree will be rejected",
        "by the sandbox boundary.",
        "",
        "Per-task lifecycle:",
        "1. Read the task description AND any prior comments (esp. reviewer feedback).",
        "2. Make the minimal change that satisfies the task or addresses the feedback.",
        "3. Run typecheck and tests if you touched code:",
        "   `pnpm typecheck` and `pnpm test`. Fix failures before committing.",
        '4. `git add` + `git commit -m "<task_id>: <short summary>"`',
        "   (The worktree is already on the right branch — no need to checkout.)",
        `5. Hand off immediately: \`tasks(action=update, id=${event.task.id}, project_id=${event.task.project_id ?? "<project>"}, status=in_review, assignee=reviewer)\` and add a comment with the branch name + commit sha + one-line summary. **The \`project_id\` is mandatory** when the task lives on a per-project tracker (e.g. GitHub issues) — without it the tool falls back to the default backend and the update silently 404s.`,
        "6. **Stop here.** The host pushes branches and merges them; your commit",
        "   reaches the host via the .git bind mount as soon as `git commit`",
        "   succeeds. `git push` is unnecessary and will fail (no SSH key in",
        "   the container) — skip it.",
        "7. If you cannot proceed (missing context, infra issue), update to `blocked` with a clear reason and STOP — do not fabricate paths or files.",
        "",
        "**Reconnaissance budget.** Tool calls are expensive — burning them on `ls`,",
        "`cat`, and `read` without writing or committing is the #1 failure mode.",
        "Hard limits, in order:",
        "  - After ~15 tool calls without writing/editing any file, STOP exploring.",
        "    Comment on the task with: (a) files you inspected, (b) what you",
        "    concluded, (c) what's blocking implementation. Then exit.",
        "  - Do not re-read or re-`ls` paths you've already touched this session.",
        "    If the answer is in your scrollback, look there first.",
        "  - When in doubt, commit the smallest viable progress. A trivial",
        "    commit that gets reviewed beats an empty session every time.",
        "",
        "Do NOT touch ~/.tailored-ai/, agent.db, or config.yaml. Do NOT commit secrets.",
        "",
      ].join("\n");
    } else if (agentName === "reviewer" && worktree) {
      rolePreamble = [
        "You are the **reviewer** agent. The coder has produced a branch you need to review.",
        `- Worktree path: ${worktree.path}`,
        `- Branch: ${worktree.branch}`,
        "- Status: checked out at HEAD of the branch",
        "",
        "**Mandatory gates — you MUST run these BEFORE deciding.** A branch",
        "that fails any gate cannot be approved, regardless of how clean the",
        "diff looks. Past mistakes: approved PRs that didn't compile, that",
        "regressed sandbox code, that pulled in unrelated commits.",
        "",
        "GATE 1 — Build & tests (this is the gate that catches imagined APIs):",
        "  `pnpm install` then `pnpm typecheck` then `pnpm test`",
        "  If ANY of those fail, REQUEST CHANGES. Quote the first failing",
        "  error in your comment. Do not approve a branch that doesn't build.",
        "",
        "  **If a gate command can't run for environment reasons** (pnpm",
        "  download failure, Node version mismatch, container missing a",
        "  binary, etc.) treat that as a GATE 1 FAILURE — do NOT rationalize",
        "  with 'this is infrastructure, not code'. REQUEST CHANGES with",
        "  blocked_reason='env: <what failed>'. The supervisor and user will",
        "  fix the environment; the branch stays unapproved until the gate",
        "  actually runs. Approving past an unrun gate has caused multiple",
        "  reverts already.",
        "",
        "GATE 2 — Rebase preflight (catches stale-base regressions):",
        "  `git fetch origin main && git merge-base HEAD origin/main`",
        "  If merge-base != origin/main HEAD, do a probe merge:",
        "    `git merge --no-commit --no-ff origin/main`",
        "    If conflicts OR post-merge `pnpm typecheck`/`pnpm test` fail,",
        "    REQUEST CHANGES with 'needs rebase against main'. Then",
        "    `git merge --abort` to clean up before exiting.",
        "  Branches that delete files only because main moved forward are",
        "  stale, not malicious — say so in the request-changes comment.",
        "",
        "GATE 3 — Scope check:",
        "  Compare the merge-base diff (`git diff <merge-base>..HEAD`) to the",
        "  task description. If the branch touches files outside the task's",
        "  stated scope, REQUEST CHANGES with 'scope creep — split into",
        "  separate task'. The coder is supposed to commit only this task's",
        "  work; an extra commit for a different ptask_ id is a red flag.",
        "",
        "Diff vocabulary cheat-sheet:",
        "  `git merge-base main HEAD`               → fork SHA",
        "  `git diff <merge-base>..HEAD`            → only this branch's changes",
        "  `git log <merge-base>..HEAD --oneline`   → only this branch's commits",
        "  If merge-base == origin/main, the branch is up-to-date and",
        "  `git diff main..HEAD` is identical.",
        "",
        "Decision (only after all three gates pass):",
        `  **\`project_id\` is mandatory on every tasks() call.** Pass \`project_id=${event.task.project_id ?? "<project>"}\` ` +
          "or the update silently 404s on the default backend instead of " +
          "the project's tracker (GitHub issues, etc.).",
        "  - **APPROVE**: " +
          `\`tasks(action=update, id=${event.task.id}, project_id=${event.task.project_id ?? "<project>"}, status=in_review, assignee=${ownerName})\`. ` +
          "Comment must state: (a) what was done, (b) which gates passed",
        "    (build/test output summary, merge-base SHA, scope verified).",
        "  - **REQUEST CHANGES**: " +
          `\`tasks(action=update, id=${event.task.id}, project_id=${event.task.project_id ?? "<project>"}, status=in_progress, assignee=coder)\`. ` +
          "Comment lists specific actionable items — file path, line ref,",
        "    what's wrong, what's expected. Include the first error from the",
        "    failing gate so the coder doesn't have to re-run it.",
        "",
        "You do NOT commit or amend the branch. Pushing IS allowed when",
        "your custom configuration calls for it (e.g. to open a PR on",
        "approve) — the worktree's per-task branch is isolated so a push",
        "can't pollute main. Before the first push in a fresh container,",
        "run `gh auth setup-git` to wire git's credential helper through",
        "the GH_TOKEN your sandbox env carries.",
        "Aim for one decisive decision per review pass — don't bounce trivial issues; do bounce real problems.",
        "",
      ].join("\n");
    }
    const prompt = [
      rolePreamble,
      "Task event received. Details:",
      `- Task ID: ${event.task.id}`,
      `- Event type: ${event.action}`,
      `- Task title: ${event.task.title}`,
      `- Task description: ${event.task.description ?? "(none)"}`,
      "",
      configPrompt,
    ]
      .filter(Boolean)
      .join("\n");

    // Ensure tasks/task_query tools are always available (even if the profile filters them out)
    const taskToolNames = new Set(["tasks", "task_query"]);
    const extraTools = allTools.filter((t) => taskToolNames.has(t.name));

    let response: string;
    // Captured outside the finally so stall handling (below) can inspect
    // the preserved worktree without re-querying git.
    let worktreePreservedPath: string | null = null;
    try {
      // Linked worktrees use the parent repo's .git directory: the
      // worktree's `.git` is a FILE containing `gitdir: <parent>/.git/
      // worktrees/<name>`. For git operations inside a containerized
      // dispatch to follow that pointer, the parent .git must be bind-
      // mounted at the same absolute path. Isolation still holds — the
      // model can read git metadata (objects, refs) but the host's
      // checked-out source tree at <parent>/packages/... remains invisible.
      const parentRepoGitDir =
        worktree && event.task.project_id
          ? (() => {
              const project = getProject(this.runtime.db, event.task.project_id!);
              return project?.path ? `${project.path}/.git` : undefined;
            })()
          : undefined;

      response = await runAgentLoop(prompt, {
        ...this.runtime.buildLoopOptions({
          session,
          agentName,
          extraTools,
          project: projectOverride ?? null,
        }),
        // Hard sandbox boundary: when there's a worktree, file/exec tools
        // reject paths that resolve outside it. Closes the absolute-path
        // escape where a coder could write into the parent checkout via
        // an absolute path that skips past the worktree root.
        toolContextExtras: worktree ? { workingDirectoryBoundary: worktree.path } : undefined,
        sandboxMounts: parentRepoGitDir ? [{ hostPath: parentRepoGitDir, sandboxPath: parentRepoGitDir }] : undefined,
        onToolCall: (name, args) => {
          console.log(`${logPrefix} tool: ${name}(${JSON.stringify(args)})`);
        },
        onToolResult: (name, result) => {
          console.log(`${logPrefix} result: ${name} → ${result.slice(0, 200)}`);
        },
      });
    } finally {
      // Worktree cleanup: returns { preservedPath } when the agent left
      // uncommitted changes. We log this — but do NOT write it as a task
      // comment. The user-facing comment timeline should only contain
      // substantive coder/reviewer output, not bookkeeping. The next agent
      // in the chain (reviewer / coder again) discovers the worktree via
      // the branch reuse logic in createWorktree.
      if (worktree) {
        try {
          const cleanup = await worktree.cleanup();
          if (cleanup.preservedPath) {
            worktreePreservedPath = cleanup.preservedPath;
            console.log(`${logPrefix} worktree preserved at ${cleanup.preservedPath} (uncommitted changes)`);
          } else {
            console.log(`${logPrefix} worktree cleaned up; branch ${worktree.branch} retained`);
          }
        } catch (err) {
          console.error(`${logPrefix} worktree cleanup failed:`, (err as Error).message);
        }
      }
    }

    // --- afterRun hooks ---
    if (hooks.afterRun.length > 0) {
      const afterVars = { ...templateVars, response: response ?? "" };
      await executeHooks(hooks.afterRun, allTools, afterVars, session.id, logPrefix, promptsConfig);
    }

    // Re-read the task to see how the agent left it. The agent may have
    // updated status/assignee mid-run; downstream subscribers (notifier,
    // scope-creep, stall guard) decide what to do based on the FINAL
    // state, not what triggered us.
    const finalTask = this.runtime.db.prepare("SELECT * FROM project_tasks WHERE id = ?").get(event.task.id) as
      | (ProjectTask & { tags: string })
      | undefined;
    const finalAssignee = (finalTask?.assignee ?? "").trim() || null;
    const finalStatus = finalTask?.status ?? event.task.status;

    // Stall vs clean completion. A loop ending with `[Agent stopped: …]`
    // means the model burned its budget without transitioning the task.
    // Slice 3 step 3 of the platform vision: stall handling moved to the
    // StallGuard plugin. The watcher emits `agent.stalled` (instead of
    // `agent.completed`) when it detects a stall so the guard can decide
    // retry-or-block. For terminal statuses (blocked/done) we never
    // treat the response as a stall — those are intentional terminations.
    const stallReason = detectStall(response);
    const isStall = stallReason !== null && finalStatus !== "blocked" && finalStatus !== "done";
    const eventName = isStall ? "agent.stalled" : "agent.completed";
    // Both payloads are structurally identical apart from `stallReason`.
    const basePayload = {
      taskId: event.task.id,
      projectId: event.task.project_id ?? undefined,
      agentName,
      action: event.action,
      task: {
        id: event.task.id,
        title: event.task.title,
        description: event.task.description,
        status: event.task.status,
        assignee: event.task.assignee,
      },
      finalTask: {
        id: finalTask?.id ?? event.task.id,
        title: finalTask?.title ?? event.task.title,
        description: finalTask?.description ?? event.task.description,
        status: finalStatus,
        assignee: finalAssignee,
      },
      response,
      worktree:
        worktree && worktreeRepoPath
          ? {
              repoPath: worktreeRepoPath,
              worktreePath: worktree.path,
              branch: worktree.branch,
              preservedPath: worktreePreservedPath,
            }
          : undefined,
    };
    if (eventName === "agent.stalled") {
      this.runtime.events.emit("agent.stalled", { ...basePayload, stallReason: stallReason! });
    } else {
      this.runtime.events.emit("agent.completed", basePayload);
    }
  }

  stop(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    this.dispatchRequestSub.dispose();
    console.log("[task-watcher] Stopped");
  }
}

// Branch-safe slug — strips out characters git refs reject, collapses
// whitespace, lowercases. Used to build `agent/<task_id>-<slug>` branch
// names. Trimmed to 30 chars by the caller.
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Returns a short stall reason when `response` matches the agent loop's
 * `[Agent stopped: …]` terminators, or null when the loop ended cleanly.
 * `[Sleep] …` is NOT a stall — that's how the default agent ends ticks
 * intentionally. Used by the watcher to route to `agent.stalled`
 * instead of `agent.completed`; also exported for plugins that want to
 * detect stalls in their own response inspection paths.
 */
export function detectStall(response: string): string | null {
  if (!response) return null;
  const trimmed = response.trim();
  const m = trimmed.match(/^\[Agent stopped:\s*([^\]]+)\]/);
  if (!m) return null;
  return m[1].trim();
}

/**
 * Scope-creep detection. Looks at commits on the per-task branch since
 * fork from main and extracts any `ptask_<8 hex>` ids in commit
 * messages. If more than one distinct id appears, the branch is mixing
 * work for multiple tasks — return the foreign ids so the caller can
 * flag it.
 *
 * Runs against the parent repo (`repoPath`) and references the branch
 * by name, so it survives worktree cleanup (the prior worktree-rooted
 * implementation silently no-opped after a clean coder→reviewer
 * handoff, because the worktree dir was already gone).
 *
 * Returns null on any git error (treat as "no signal").
 */
export async function detectScopeCreep(args: {
  repoPath: string;
  branch: string;
  expectedTaskId: string;
}): Promise<{ foreignTaskIds: string[]; commitCount: number } | null> {
  const { repoPath, branch, expectedTaskId } = args;
  try {
    const mergeBase = (await exec("git", ["-C", repoPath, "merge-base", "main", branch])).stdout.trim();
    if (!mergeBase) return null;
    const log = (await exec("git", ["-C", repoPath, "log", `${mergeBase}..${branch}`, "--pretty=%s"])).stdout;
    const lines = log.split("\n").filter((l) => l.trim().length > 0);
    const found = new Set<string>();
    for (const line of lines) {
      const matches = line.match(/ptask_[0-9a-f]{8}/g) ?? [];
      for (const id of matches) found.add(id);
    }
    found.delete(expectedTaskId);
    return { foreignTaskIds: Array.from(found), commitCount: lines.length };
  } catch {
    return null;
  }
}
