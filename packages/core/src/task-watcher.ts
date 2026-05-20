import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { executeHooks } from "./agent/hooks.js";
import { expandPrompt } from "./prompts/expand.js";
import { runAgentLoop } from "./agent/loop.js";
import { resolveAgent } from "./agent/agents.js";
import { findOrCreateSession, resetSession } from "./agent/session.js";
import type { DiscordChannel } from "./channels/discord.js";
import { getProject } from "./db/project-queries.js";
import { addTaskComment, updateProjectTask, type ProjectTask } from "./db/task-queries.js";
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
  discord?: DiscordChannel;
}

export class TaskWatcher {
  private runtime: AgentRuntime;
  private discord?: DiscordChannel;
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
    this.discord = opts.discord;
  }

  setDiscord(discord: DiscordChannel | undefined): void {
    this.discord = discord;
  }

  /**
   * Convenience: notify by id. Looks up the current task row and forwards
   * to notify(). Used by the tasks tool (which has the id at mutation
   * time but not the full row). Silently no-ops if the row is gone.
   */
  notifyById(action: TaskEvent["action"], taskId: string): void {
    const row = this.runtime.db
      .prepare("SELECT * FROM project_tasks WHERE id = ?")
      .get(taskId) as ProjectTask | undefined;
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
      const isKnownAgent =
        newAssignee !== null && Boolean(this.runtime.getConfig().agents?.[newAssignee]);
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
    const assigneeIsAgent =
      assignee !== undefined && Boolean(config_.agents?.[assignee]);
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
      : findOrCreateSession(this.runtime.db, `discord:${ownerId}`, resolved.model, resolved.provider);

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
        `- Worktree path: ${worktree.path}`,
        `- Branch: ${worktree.branch}`,
        "- Status: checked out (may have prior commits if this is an iteration)",
        "",
        "**HARD RULE — branch safety.** You MUST work on the branch above",
        `(\`${worktree.branch}\`). Before every \`git commit\`, verify the current`,
        "branch with `git -C <worktree-path> branch --show-current`. If it",
        "returns `main` or any trunk-like name (master, develop, prod),",
        "STOP IMMEDIATELY — do NOT commit. Comment on the task explaining",
        "what went wrong and exit. Committing to main poisons the trunk",
        "and causes pollution that's expensive to clean up.",
        "",
        "Per-task lifecycle:",
        "1. Read the task description AND any prior comments (esp. reviewer feedback).",
        "2. Make the minimal change that satisfies the task or addresses the feedback.",
        "3. Run typecheck and tests if you touched code:",
        "   `pnpm typecheck` and `pnpm test`. Fix failures before committing.",
        `4. Branch check: \`git -C ${worktree.path} branch --show-current\` — must return \`${worktree.branch}\`.`,
        "5. `git add` + `git commit` with a clear message.",
        "6. `git push -u origin <branch>` if a remote is configured.",
        `7. Hand off to the reviewer: \`tasks(action=update, id=${event.task.id}, status=in_review, assignee=reviewer)\` and add a comment with branch name + commit sha + one-line summary.`,
        "8. If you cannot proceed (missing context, infra issue), update to `blocked` with a clear reason and STOP — do not fabricate paths or files.",
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
        "Your review process:",
        "1. Read the task description and ALL prior comments to understand what was asked.",
        "2. Inspect the branch diff against main:",
        "   `git diff main..HEAD` and `git log main..HEAD --oneline` from the worktree.",
        "3. Read any files the diff touches for surrounding context.",
        "4. Run `pnpm typecheck` and `pnpm test`. If they fail, that's grounds for changes.",
        "5. Decide:",
        "   - **APPROVE** (looks correct, minimal, tests pass): " +
          `\`tasks(action=update, id=${event.task.id}, status=in_review, assignee=${ownerName})\`. ` +
          "Add a comment summarizing why you approved (what was done, what you verified).",
        "   - **REQUEST CHANGES** (bug, scope creep, broken tests, missing context, security issue): " +
          `\`tasks(action=update, id=${event.task.id}, status=in_progress, assignee=coder)\`. ` +
          "Add a comment listing specific, actionable items the coder should fix. Be precise — file paths, line refs, what's wrong, what's expected.",
        "",
        "You do NOT commit, push, or amend the branch yourself. You only review.",
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
    ].filter(Boolean).join("\n");

    // Ensure tasks/task_query tools are always available (even if the profile filters them out)
    const taskToolNames = new Set(["tasks", "task_query"]);
    const extraTools = allTools.filter((t) => taskToolNames.has(t.name));

    let response: string;
    // Captured outside the finally so stall handling (below) can inspect
    // the preserved worktree without re-querying git.
    let worktreePreservedPath: string | null = null;
    try {
      response = await runAgentLoop(prompt, {
        ...this.runtime.buildLoopOptions({
          session,
          agentName,
          extraTools,
          project: projectOverride ?? null,
        }),
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
    let finalTask = this.runtime.db
      .prepare("SELECT * FROM project_tasks WHERE id = ?")
      .get(event.task.id) as
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
      finalTask = this.runtime.db
        .prepare("SELECT * FROM project_tasks WHERE id = ?")
        .get(event.task.id) as (ProjectTask & { tags: string }) | undefined;
      finalAssignee = (finalTask?.assignee ?? "").trim() || null;
      finalStatus = finalTask?.status ?? event.task.status;
    }

    if (this.shouldSuppressDelivery(finalAssignee, finalStatus)) {
      console.log(`${logPrefix} suppressing delivery — task in-flight (assignee=${finalAssignee}, status=${finalStatus})`);
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
      .prepare(
        "SELECT content FROM task_comments WHERE task_id = ? AND author = ? AND content LIKE ?",
      )
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
        const refreshed = this.runtime.db
          .prepare("SELECT * FROM project_tasks WHERE id = ?")
          .get(taskId) as ProjectTask | undefined;
        if (!refreshed) return;
        let tags: string[] = [];
        try {
          tags = JSON.parse((refreshed as unknown as { tags: string }).tags) ?? [];
        } catch {
          tags = [];
        }
        this.notify(
          { action: "updated", task: { ...refreshed, tags } as ProjectTask },
          { force: true },
        );
      }, 500);
      return { retried: true };
    }

    // Out of retries: transition to blocked so the user sees it.
    console.log(`${logPrefix} stall detected (#${attempt}) — out of retries, transitioning to blocked`);
    updateProjectTask(this.runtime.db, taskId, {
      status: "blocked",
      blocked_reason: `coder-stalled after ${attempt} attempts: ${stallReason}`,
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
    event: TaskEvent,
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
      .prepare(
        "SELECT author, content FROM task_comments WHERE task_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(finalTask.id) as { author: string; content: string } | undefined;
    if (latestComment) {
      const truncated = latestComment.content.length > 600
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
      (commentText.includes(respTrimmed.slice(0, probe)) ||
        respTrimmed.includes(commentText.slice(0, probe)));
    if (respTrimmed && respTrimmed.length > 40 && !overlapsComment) {
      lines.push("");
      lines.push("---");
      lines.push(
        respTrimmed.length > 500
          ? `${respTrimmed.slice(0, 500).trim()} …`
          : respTrimmed,
      );
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
      if (!this.discord) {
        console.error(`${logPrefix} discord delivery configured but Discord is not connected`);
        return;
      }
      await this.discord.send(target, response);
      console.log(`${logPrefix} Delivered to Discord channel ${target}`);
      return;
    }

    if (channel === "discord-dm") {
      const target = config.delivery?.target ?? this.runtime.getConfig().channels.discord?.owner;
      if (!target) {
        console.error(`${logPrefix} discord-dm delivery configured but no target user ID or discord owner`);
        return;
      }
      if (!this.discord) {
        console.error(`${logPrefix} discord-dm delivery configured but Discord is not connected`);
        return;
      }
      await this.discord.sendDM(target, response);
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
async function summarizeWorktreeChanges(
  worktreePath: string,
): Promise<{ stat: string; status: string } | null> {
  try {
    const [status, stat] = await Promise.all([
      exec("git", ["-C", worktreePath, "status", "--short"]).then((r) => r.stdout).catch(() => ""),
      exec("git", ["-C", worktreePath, "diff", "--stat", "HEAD"]).then((r) => r.stdout).catch(() => ""),
    ]);
    return { status, stat };
  } catch {
    return null;
  }
}
