import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveAgent } from "./agent/agents.js";
import { executeHooks } from "./agent/hooks.js";
import { runAgentLoop } from "./agent/loop.js";
import { findOrCreateSession, resetSession } from "./agent/session.js";
import type { OutboundNotifier } from "./channels/outbound.js";
import { getProject } from "./db/project-queries.js";
import { addTaskComment, type ProjectTask, updateProjectTask } from "./db/task-queries.js";
import { expandPrompt } from "./prompts/expand.js";
import type { AgentRuntime } from "./runtime.js";
import { createWorktree, type Worktree } from "./worktree.js";

const exec = promisify(execFile);

/** Sentinel author for watcher-authored bookkeeping comments. */
const WATCHER_COMMENT_AUTHOR = "task-watcher";
/** Prefix on stall comments so subsequent runs can count prior attempts. */
const STALL_COMMENT_PREFIX = "STALL #";

export interface TaskEvent {
  action: "created" | "updated" | "commented";
  task: ProjectTask;
}

export interface TaskWatcherOptions {
  runtime: AgentRuntime;
  notifier?: OutboundNotifier;
  /** @deprecated Use notifier instead. */
  discord?: OutboundNotifier;
}

export class TaskWatcher {
  private runtime: AgentRuntime;
  private notifier?: OutboundNotifier;
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

  constructor(opts: TaskWatcherOptions) {
    this.runtime = opts.runtime;
    this.notifier = opts.notifier ?? opts.discord;
  }

  setNotifier(notifier: OutboundNotifier | undefined): void {
    this.notifier = notifier;
  }

  /** @deprecated Use setNotifier instead. */
  setDiscord(notifier: OutboundNotifier | undefined): void {
    this.notifier = notifier;
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
    // updated status/assignee mid-run; the delivery decision depends on
    // the FINAL state, not what triggered us.
    let finalTask = this.runtime.db.prepare("SELECT * FROM project_tasks WHERE id = ?").get(event.task.id) as
      | (ProjectTask & { tags: string })
      | undefined;
    let finalAssignee = (finalTask?.assignee ?? "").trim() || null;
    let finalStatus = finalTask?.status ?? event.task.status;

    // Stall handling. A loop ending with `[Agent stopped: …]` means the
    // model burned its budget without transitioning the task. The
    // `shouldSuppressDelivery` rule would silently hide this (assignee is
    // still a known agent, status is still backlog/in_progress), so we
    // intercept here, write a structured comment, and either retry or
    // transition to blocked. See docs/agent-unification.md (Phase 6
    // follow-up: stall detection).
    const stallReason = detectStall(response);
    if (stallReason && finalStatus !== "blocked" && finalStatus !== "done") {
      const handled = await this.handleStall({
        event,
        stallReason,
        worktreePath: worktreePreservedPath,
        logPrefix,
      });
      // handleStall mutates the task; re-read the row so the delivery
      // logic below sees the new state.
      if (handled.retried) {
        // Retry was enqueued; the next pass will deliver. Nothing to do here.
        return;
      }
      finalTask = this.runtime.db.prepare("SELECT * FROM project_tasks WHERE id = ?").get(event.task.id) as
        | (ProjectTask & { tags: string })
        | undefined;
      finalAssignee = (finalTask?.assignee ?? "").trim() || null;
      finalStatus = finalTask?.status ?? event.task.status;
    }

    // Scope-creep flag: when the coder hands off to the reviewer, peek at
    // the branch commits and flag if any other ptask_ ids show up. This
    // is a watcher-authored comment the reviewer will see in GATE 3 of its
    // preamble, so it gets caught even if the reviewer is a small model.
    if (agentName === "coder" && finalAssignee === "reviewer" && worktree && finalStatus === "in_review") {
      try {
        const scope = await detectScopeCreep(worktree.path, event.task.id);
        if (scope && scope.foreignTaskIds.length > 0) {
          addTaskComment(this.runtime.db, event.task.id, {
            author: WATCHER_COMMENT_AUTHOR,
            content: [
              `SCOPE WARNING: branch contains commits for ${scope.foreignTaskIds.length} other task(s): ${scope.foreignTaskIds.join(", ")}.`,
              "",
              "Reviewer: apply GATE 3 (scope check) — these commits should",
              "be on separate branches. Request changes with 'split into",
              "separate task' unless the foreign work is genuinely required",
              "for this task to compile/run.",
            ].join("\n"),
          });
          console.log(
            `${logPrefix} scope warning: branch has commits for foreign task(s) ${scope.foreignTaskIds.join(",")}`,
          );
        }
      } catch (err) {
        console.warn(`${logPrefix} scope-creep check failed:`, (err as Error).message);
      }
    }

    if (this.shouldSuppressDelivery(finalAssignee, finalStatus)) {
      console.log(
        `${logPrefix} suppressing delivery — task in-flight (assignee=${finalAssignee}, status=${finalStatus})`,
      );
      return;
    }

    const envelope = await this.buildNotification(event, finalTask ?? event.task, finalAssignee, finalStatus, response);
    await this.deliver(envelope, logPrefix);
  }

  /**
   * Called when the agent loop returned `[Agent stopped: …]`. Counts
   * prior `STALL #N` comments on this task; if we're under the retry
   * cap, requeues the event with `force: true`. Otherwise transitions
   * the task to blocked so the user sees it on the dashboard. Always
   * writes a structured stall comment so the trail is preserved.
   */
  private async handleStall(args: {
    event: TaskEvent;
    stallReason: string;
    worktreePath: string | null;
    logPrefix: string;
  }): Promise<{ retried: boolean }> {
    const { event, stallReason, worktreePath, logPrefix } = args;
    const taskId = event.task.id;

    // Count prior stalls. Each watcher-authored stall comment carries
    // `STALL #N: …` as its first line so we can extract the highest N.
    const prior = this.runtime.db
      .prepare("SELECT content FROM task_comments WHERE task_id = ? AND author = ? AND content LIKE ?")
      .all(taskId, WATCHER_COMMENT_AUTHOR, `${STALL_COMMENT_PREFIX}%`) as { content: string }[];
    const priorAttempt = prior
      .map((r) => {
        const m = r.content.match(/^STALL #(\d+)/);
        return m ? Number.parseInt(m[1], 10) : 0;
      })
      .reduce((a, b) => (a > b ? a : b), 0);
    const attempt = priorAttempt + 1;

    const worktreeStatus = worktreePath ? await summarizeWorktreeChanges(worktreePath) : null;
    const comment = formatStallComment(attempt, stallReason, worktreePath, worktreeStatus);
    addTaskComment(this.runtime.db, taskId, { author: WATCHER_COMMENT_AUTHOR, content: comment });

    const maxRetries = this.runtime.getConfig().taskWatcher.maxStallRetries ?? 1;
    if (attempt <= maxRetries) {
      console.log(`${logPrefix} stall detected (#${attempt}) — scheduling retry`);
      // Bypass the `lastFiredAssignee` gate so the same assignee re-fires.
      // Small delay lets logs flush and the user-facing comment land first.
      setTimeout(() => {
        const refreshed = this.runtime.db.prepare("SELECT * FROM project_tasks WHERE id = ?").get(taskId) as
          | ProjectTask
          | undefined;
        if (!refreshed) return;
        let tags: string[] = [];
        try {
          tags = JSON.parse((refreshed as unknown as { tags: string }).tags) ?? [];
        } catch {
          tags = [];
        }
        this.notify({ action: "updated", task: { ...refreshed, tags } as ProjectTask }, { force: true });
      }, 500);
      return { retried: true };
    }

    // Out of retries: transition to blocked AND leave a structured note
    // suggesting decomposition. A task that stalls twice is almost always
    // too big for one coder pass — splitting it is the right next step.
    console.log(`${logPrefix} stall detected (#${attempt}) — out of retries, transitioning to blocked`);
    const decomposeHint = [
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
    addTaskComment(this.runtime.db, taskId, {
      author: WATCHER_COMMENT_AUTHOR,
      content: decomposeHint,
    });
    updateProjectTask(this.runtime.db, taskId, {
      status: "blocked",
      blocked_reason: `coder-stalled after ${attempt} attempts (suggest decomposition): ${stallReason}`,
    });
    return { retried: false };
  }

  /**
   * Skip the Discord DM when the task is still being worked on by another
   * agent. The user only wants to hear when (a) the loop hits the user,
   * (b) something is blocked, or (c) something is done. Mid-flight
   * handoffs between agents are noise.
   */
  private shouldSuppressDelivery(finalAssignee: string | null, finalStatus: string): boolean {
    // Block / done / archived always deliver — they need user attention or are terminal.
    if (finalStatus === "blocked" || finalStatus === "done" || finalStatus === "archived") return false;
    // No assignee at all → user gets a triage ping.
    if (!finalAssignee) return false;
    // Assignee is a defined agent → still in-flight, suppress.
    const isKnownAgent = Boolean(this.runtime.getConfig().agents?.[finalAssignee]);
    if (isKnownAgent) return true;
    // Otherwise (assignee is a person / external) → deliver.
    return false;
  }

  /**
   * Build the structured Discord message: header (status + task id + title),
   * action context, what-to-do-next, then a trimmed slice of the agent's
   * own response as supporting context. Keeps the user oriented even when
   * the agent's free-form response is opaque.
   */
  private async buildNotification(
    _event: TaskEvent,
    finalTask: { id: string; title: string; description?: string; status: string },
    finalAssignee: string | null,
    finalStatus: string,
    agentResponse: string,
  ): Promise<string> {
    const emoji = emojiForStatus(finalStatus, finalAssignee);
    const title = (finalTask.title ?? "").slice(0, 100);
    const lines: string[] = [];
    lines.push(`${emoji} **${finalTask.id}** — ${title}`);
    lines.push(`status: ${finalStatus} · assignee: ${finalAssignee ?? "(unassigned)"}`);

    // Pull the latest non-author=user comment for "what changed last".
    const latestComment = this.runtime.db
      .prepare("SELECT author, content FROM task_comments WHERE task_id = ? ORDER BY id DESC LIMIT 1")
      .get(finalTask.id) as { author: string; content: string } | undefined;
    if (latestComment) {
      const truncated =
        latestComment.content.length > 600
          ? `${latestComment.content.slice(0, 600).trim()} …`
          : latestComment.content.trim();
      lines.push("");
      lines.push(`> *${latestComment.author}*: ${truncated}`);
    }

    // What-to-do-next hint.
    const nextHint = this.nextActionHint(finalStatus, finalAssignee, finalTask.id);
    if (nextHint) {
      lines.push("");
      lines.push(nextHint);
    }

    // Append the agent's response only when it adds info beyond the comment
    // we already surfaced. Most of the time the latest comment IS the agent's
    // summary, so this would be a duplicate. Check both directions so we
    // catch the case where one string is a prefix or extension of the other.
    const respTrimmed = agentResponse.trim();
    const commentText = latestComment?.content ?? "";
    const probe = 60;
    const overlapsComment =
      respTrimmed.length >= probe &&
      (commentText.includes(respTrimmed.slice(0, probe)) || respTrimmed.includes(commentText.slice(0, probe)));
    if (respTrimmed && respTrimmed.length > 40 && !overlapsComment) {
      lines.push("");
      lines.push("---");
      lines.push(respTrimmed.length > 500 ? `${respTrimmed.slice(0, 500).trim()} …` : respTrimmed);
    }
    return lines.join("\n");
  }

  /**
   * One-line guidance on what the user should do next. Returns empty string
   * when no action is needed (e.g., terminal status).
   */
  private nextActionHint(status: string, assignee: string | null, taskId: string): string {
    if (status === "done" || status === "archived") return "✅ closed — no action.";
    if (status === "blocked") return "🚫 **blocked** — needs your decision (see comment above).";
    if (status === "in_review" && (assignee === null || !this.isKnownAgent(assignee))) {
      const branch = this.findBranchInTaskComments(taskId);
      if (branch) {
        return [
          `🔍 **ready for your review.**`,
          `\`\`\``,
          `git diff main..${branch}`,
          `git checkout main && git merge --ff-only ${branch}`,
          `\`\`\``,
        ].join("\n");
      }
      return "🔍 **ready for your review** — see comments above.";
    }
    return "";
  }

  /**
   * Scan ALL comments on a task for a `Branch: <name>` reference and return
   * the most recent one. Necessary because the most recent comment may be
   * a reviewer's prose, not the coder's branch announcement.
   */
  private findBranchInTaskComments(taskId: string): string | null {
    const rows = this.runtime.db
      .prepare("SELECT content FROM task_comments WHERE task_id = ? ORDER BY id DESC")
      .all(taskId) as Array<{ content: string }>;
    for (const r of rows) {
      const m = r.content.match(/Branch:\s+(\S+?)(?:[.\s]|$)/);
      if (m?.[1]) return m[1].replace(/\.$/, "");
    }
    return null;
  }

  private isKnownAgent(name: string): boolean {
    return Boolean(this.runtime.getConfig().agents?.[name]);
  }

  private async deliver(response: string, logPrefix: string): Promise<void> {
    const config = this.runtime.getConfig().taskWatcher;
    const channel = config.delivery?.channel ?? "log";

    if (channel === "discord") {
      const target = config.delivery?.target;
      if (!target) {
        console.error(`${logPrefix} discord delivery configured but no target channel ID`);
        return;
      }
      if (!this.notifier) {
        console.error(`${logPrefix} discord delivery configured but Discord is not connected`);
        return;
      }
      await this.notifier.send(target, response);
      console.log(`${logPrefix} Delivered to Discord channel ${target}`);
      return;
    }

    if (channel === "discord-dm") {
      const target = config.delivery?.target ?? this.runtime.getConfig().channels.discord?.owner;
      if (!target) {
        console.error(`${logPrefix} discord-dm delivery configured but no target user ID or discord owner`);
        return;
      }
      if (!this.notifier) {
        console.error(`${logPrefix} discord-dm delivery configured but Discord is not connected`);
        return;
      }
      await this.notifier.sendDM(target, response);
      console.log(`${logPrefix} Delivered as DM to user ${target}`);
      return;
    }

    // Default: log
    console.log(`${logPrefix} ${response}`);
  }

  stop(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    console.log("[task-watcher] Stopped");
  }
}

function emojiForStatus(status: string, assignee: string | null): string {
  if (status === "done" || status === "archived") return "✅";
  if (status === "blocked") return "🚫";
  if (status === "in_review") return assignee && /^[A-Z]/.test(assignee) ? "🔍" : "⏳";
  if (status === "in_progress") return "🛠️";
  if (status === "backlog") return "📥";
  return "📝";
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
 * intentionally.
 */
export function detectStall(response: string): string | null {
  if (!response) return null;
  const trimmed = response.trim();
  const m = trimmed.match(/^\[Agent stopped:\s*([^\]]+)\]/);
  if (!m) return null;
  return m[1].trim();
}

/**
 * Renders the watcher's stall comment. Goes onto the task's comment
 * timeline so the user (and the next coder run) can see what was
 * attempted. Format is `STALL #N: …` so subsequent stalls can count
 * priors with a simple LIKE query.
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

/** Runs `git status --short` and `git diff --stat HEAD` in the preserved worktree. */
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

/**
 * Scope-creep detection. Looks at commits on the branch since fork from
 * main and extracts any `ptask_<8 hex>` ids in commit messages. If more
 * than one distinct id appears, the branch is mixing work for multiple
 * tasks — return the foreign ids so the watcher can flag it.
 *
 * Returns null on any git error (treat as "no signal").
 */
export async function detectScopeCreep(
  worktreePath: string,
  expectedTaskId: string,
): Promise<{ foreignTaskIds: string[]; commitCount: number } | null> {
  try {
    const mergeBase = (await exec("git", ["-C", worktreePath, "merge-base", "main", "HEAD"])).stdout.trim();
    if (!mergeBase) return null;
    const log = (await exec("git", ["-C", worktreePath, "log", `${mergeBase}..HEAD`, "--pretty=%s"])).stdout;
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
