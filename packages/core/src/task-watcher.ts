import { executeHooks } from "./agent/hooks.js";
import { expandPrompt } from "./prompts/expand.js";
import { runAgentLoop } from "./agent/loop.js";
import { resolveAgent } from "./agent/agents.js";
import { findOrCreateSession, resetSession } from "./agent/session.js";
import type { DiscordChannel } from "./channels/discord.js";
import { getProject } from "./db/project-queries.js";
import { addTaskComment, type ProjectTask } from "./db/task-queries.js";
import type { AgentRuntime } from "./runtime.js";
import { createWorktree, type Worktree } from "./worktree.js";

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

  constructor(opts: TaskWatcherOptions) {
    this.runtime = opts.runtime;
    this.discord = opts.discord;
  }

  setDiscord(discord: DiscordChannel | undefined): void {
    this.discord = discord;
  }

  notify(event: TaskEvent): void {
    const config = this.runtime.getConfig().taskWatcher;
    if (!config.enabled) return;
    if (!config.triggers.includes(event.action)) return;

    const taskId = event.task.id;

    // Clear existing debounce for this task
    const existing = this.debounceTimers.get(taskId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(taskId);
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

    // Worktree pre-flight for the coder agent. We create a per-task branch
    // off HEAD and cd the loop into it so the agent operates on an isolated
    // checkout. After the loop finishes, we look at the worktree to decide
    // status — clean = nothing happened, dirty + committed = ready for
    // review (docs/agent-unification.md, Phase 5).
    let worktree: Worktree | undefined;
    let projectOverride: import("./projects/resolve.js").ProjectContext | undefined;
    if (agentName === "coder" && event.task.project_id) {
      const project = getProject(this.runtime.db, event.task.project_id);
      const repoPath = project?.path;
      if (!repoPath) {
        console.error(
          `${logPrefix} coder routed but project ${event.task.project_id} has no path — skipping worktree`,
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
            id: project.id,
            name: project.title,
            path: worktree.path,
            overlayPath: project.config_overlay_path ?? "",
            overlay: {},
          };
          console.log(`${logPrefix} created worktree at ${worktree.path} on ${branch}`);
        } catch (err) {
          console.error(`${logPrefix} worktree creation failed:`, (err as Error).message);
          // Continue without isolation — agent runs in the project's main checkout.
        }
      }
    }

    // Build prompt: structured task context + user-configured prompt.
    // For coder routes, prepend explicit branch/commit/push instructions.
    const configPrompt = await expandPrompt(config.prompt, templateVars, promptsConfig);
    const coderPreamble = worktree
      ? [
          "You are the **coder** agent. A fresh git worktree has been set up for you:",
          `- Worktree path: ${worktree.path}`,
          `- Branch: ${worktree.branch}`,
          "- Status: clean, off main HEAD",
          "",
          "Your job for this task:",
          "1. Read the task description carefully.",
          "2. Make the minimal change that satisfies it — prefer editing existing files.",
          "3. Run tests if relevant (`pnpm test`, `pnpm typecheck`).",
          "4. `git add` + `git commit` your changes with a clear message.",
          "5. Push the branch with `git push -u origin <branch>` if a remote is configured.",
          "6. Call `tasks(action=update, id=" + event.task.id + ", status=in_review)` and add a comment with the branch name + a one-line summary of what you did.",
          "7. If you cannot do the work (missing context, blocked by infra), update the task to `blocked` with a clear reason and STOP — do not invent files or paths.",
          "",
          "Do NOT touch ~/.tailored-ai/, the agent.db, or config.yaml. Do NOT commit secrets.",
          "",
        ].join("\n")
      : "";
    const prompt = [
      coderPreamble,
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
      // uncommitted changes (which we want to surface to the user). Worktree
      // with successful commits stays around — the branch carries them.
      if (worktree) {
        try {
          const cleanup = await worktree.cleanup();
          if (cleanup.preservedPath) {
            console.log(`${logPrefix} worktree preserved at ${cleanup.preservedPath} (uncommitted changes)`);
            addTaskComment(this.runtime.db, event.task.id, {
              author: "coder",
              content: `Worktree preserved at ${cleanup.preservedPath} on branch ${worktree.branch} — uncommitted changes remain. Review manually.`,
            });
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

    if (response) {
      await this.deliver(response, logPrefix);
    }
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
