import { applyTemplates, executeHooks } from "./agent/hooks.js";
import { runAgentLoop } from "./agent/loop.js";
import { resolveAgent } from "./agent/agents.js";
import { findOrCreateSession, resetSession } from "./agent/session.js";
import type { DiscordChannel } from "./channels/discord.js";
import type { ProjectTask } from "./db/task-queries.js";
import type { AgentRuntime } from "./runtime.js";

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

    const agentName = config.agent ?? config.profile;
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

    // --- beforeRun hooks ---
    if (hooks.beforeRun.length > 0) {
      const { skipped } = await executeHooks(hooks.beforeRun, allTools, templateVars, session.id, logPrefix);
      if (skipped) {
        console.log(`${logPrefix} Skipped by beforeRun hook`);
        return;
      }
    }

    // Build prompt: structured task context + user-configured prompt
    const configPrompt = applyTemplates(config.prompt, templateVars);
    const prompt = [
      "Task event received. Details:",
      `- Task ID: ${event.task.id}`,
      `- Event type: ${event.action}`,
      `- Task title: ${event.task.title}`,
      `- Task description: ${event.task.description ?? "(none)"}`,
      "",
      configPrompt,
    ].join("\n");

    // Ensure tasks/task_query tools are always available (even if the profile filters them out)
    const taskToolNames = new Set(["tasks", "task_query"]);
    const extraTools = allTools.filter((t) => taskToolNames.has(t.name));

    const response = await runAgentLoop(prompt, {
      ...this.runtime.buildLoopOptions({ session, agentName, extraTools }),
      onToolCall: (name, args) => {
        console.log(`${logPrefix} tool: ${name}(${JSON.stringify(args)})`);
      },
      onToolResult: (name, result) => {
        console.log(`${logPrefix} result: ${name} → ${result.slice(0, 200)}`);
      },
    });

    // --- afterRun hooks ---
    if (hooks.afterRun.length > 0) {
      const afterVars = { ...templateVars, response: response ?? "" };
      await executeHooks(hooks.afterRun, allTools, afterVars, session.id, logPrefix);
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
