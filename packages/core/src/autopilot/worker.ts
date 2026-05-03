import { Cron } from "croner";
import { runAgentLoop } from "../agent/loop.js";
import { resetSession } from "../agent/session.js";
import type { DiscordChannel } from "../channels/discord.js";
import {
  checkBudget,
  getAutopilotSettings,
  isInDisabledHours,
  isInQuietHours,
  recordTokenUsage,
} from "../db/autopilot-queries.js";
import type { AgentRuntime } from "../runtime.js";
import { createTaskBackend } from "../tasks/factory.js";
import type { Task, TaskBackend } from "../tasks/interface.js";
import { buildMorningDigest, recordDigestRun } from "./digest.js";

export interface AutopilotWorkerOptions {
  runtime: AgentRuntime;
  /** How often (ms) to poll for new work. Default 30s. */
  intervalMs?: number;
  /** Emits when the worker picks up or finishes a task. UI uses this for the "working on" strip. */
  onActivity?: (activity: { taskId: string; title: string } | null) => void;
  /** Discord accessor for notifications and digest delivery. */
  getDiscord?: () => DiscordChannel | undefined;
  /** Owner user id (Discord DM target) for notifications and digest. */
  getOwnerId?: () => string | undefined;
  /** Override the task backend. Defaults to `createTaskBackend(runtime.getConfig(), runtime.db)`. */
  taskBackend?: TaskBackend;
}

const DEFAULT_INTERVAL_MS = 30_000;

export class AutopilotWorker {
  private runtime: AgentRuntime;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private digestCron: Cron | undefined;
  private currentDigestTime: string | null = null;
  private running = false;
  private currentTask: { taskId: string; title: string } | undefined;
  private onActivity?: (activity: { taskId: string; title: string } | null) => void;
  private getDiscord?: () => DiscordChannel | undefined;
  private getOwnerId?: () => string | undefined;
  private tasks: TaskBackend;

  constructor(opts: AutopilotWorkerOptions) {
    this.runtime = opts.runtime;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.onActivity = opts.onActivity;
    this.getDiscord = opts.getDiscord;
    this.getOwnerId = opts.getOwnerId;
    this.tasks = opts.taskBackend ?? createTaskBackend(this.runtime.getConfig(), this.runtime.db);
  }

  start(): void {
    if (this.timer) return;
    console.log(`[autopilot] Started (interval ${this.intervalMs}ms)`);
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error("[autopilot] Tick error:", (err as Error).message);
      });
    }, this.intervalMs);
    this.syncDigestSchedule();
    // Fire once immediately.
    this.tick().catch((err) => {
      console.error("[autopilot] Initial tick error:", (err as Error).message);
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.digestCron) {
      this.digestCron.stop();
      this.digestCron = undefined;
    }
    console.log("[autopilot] Stopped");
  }

  /** Reconcile the digest cron with the current `digest_time` setting. Called at start and on any settings change. */
  syncDigestSchedule(): void {
    const settings = getAutopilotSettings(this.runtime.db);
    const time = settings.digest_time;

    if (time === this.currentDigestTime) return;
    this.currentDigestTime = time;

    if (this.digestCron) {
      this.digestCron.stop();
      this.digestCron = undefined;
    }

    if (!time) {
      console.log("[autopilot] Morning digest disabled");
      return;
    }

    const match = /^(\d{1,2}):(\d{2})$/.exec(time);
    if (!match) {
      console.warn(`[autopilot] Invalid digest_time "${time}", skipping digest schedule`);
      return;
    }
    const h = Number.parseInt(match[1], 10);
    const m = Number.parseInt(match[2], 10);
    const schedule = `${m} ${h} * * *`;

    this.digestCron = new Cron(schedule, () => {
      this.runDigest().catch((err) => {
        console.error("[autopilot] Digest error:", (err as Error).message);
      });
    });
    console.log(`[autopilot] Morning digest scheduled at ${time} daily`);
  }

  async runDigest(): Promise<void> {
    const digest = buildMorningDigest(this.runtime.db);
    if (digest.empty) {
      console.log("[autopilot] Digest empty — nothing to deliver");
      return;
    }
    recordDigestRun(this.runtime.db, digest.content);

    const discord = this.getDiscord?.();
    const ownerId = this.getOwnerId?.();
    if (discord && ownerId) {
      try {
        await discord.sendDM(ownerId, digest.content);
        console.log("[autopilot] Morning digest delivered via Discord DM");
      } catch (err) {
        console.error("[autopilot] Digest DM failed:", (err as Error).message);
      }
    } else {
      console.log(`[autopilot] Morning digest (no Discord target):\n${digest.content}`);
    }
  }

  /** Current activity, if any. */
  getActivity(): { taskId: string; title: string } | undefined {
    return this.currentTask;
  }

  /**
   * Run one iteration. Idempotent: if already running, returns immediately.
   * Exposed for tests and manual triggering.
   */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runTick();
    } finally {
      this.running = false;
    }
  }

  private async runTick(): Promise<void> {
    const db = this.runtime.db;
    const settings = getAutopilotSettings(db);

    if (settings.paused) return;
    if (isInDisabledHours(settings)) return;

    const budget = checkBudget(db, settings);
    if (budget.exceeded) return;

    // Windows rolled back under the cap — promote any budget-blocked tasks.
    const restored = await this.tasks.unblockBudgetTasks();
    if (restored > 0) {
      console.log(`[autopilot] Restored ${restored} budget-blocked task(s) to backlog`);
    }

    // Identify known agent names (the set of assignees that are real agents).
    const config = this.runtime.getConfig();
    const agentNames = Object.keys(config.agents ?? {});
    if (agentNames.length === 0) return;

    const task = await this.tasks.nextBacklogTask(agentNames);
    if (!task) return;

    const claimed = await this.tasks.claimBacklog(task.id);
    if (!claimed) return; // Someone else got there first (or status changed).

    this.currentTask = { taskId: claimed.id, title: claimed.title };
    this.onActivity?.(this.currentTask);

    try {
      await this.runTask(claimed);
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[autopilot] Task ${claimed.id} failed:`, msg);
      await this.tasks.comment(claimed.id, `Error running task: ${msg}`, "autopilot");
      await this.tasks.update(claimed.id, { status: this.tasks.statuses.blocked, blocked_reason: "error" });
      await this.notifyNeedsHuman(`Task ${claimed.id} errored: ${claimed.title}\n${msg}`);
    } finally {
      this.currentTask = undefined;
      this.onActivity?.(null);
    }
  }

  private async notifyNeedsHuman(message: string): Promise<void> {
    const settings = getAutopilotSettings(this.runtime.db);
    if (isInQuietHours(settings)) {
      console.log(`[autopilot] Suppressing notification during quiet hours: ${message.slice(0, 80)}`);
      return;
    }
    const discord = this.getDiscord?.();
    const ownerId = this.getOwnerId?.();
    if (!discord || !ownerId) return;
    try {
      await discord.sendDM(ownerId, message);
    } catch (err) {
      console.error("[autopilot] Notify DM failed:", (err as Error).message);
    }
  }

  private async runTask(task: Task): Promise<void> {
    const db = this.runtime.db;
    const agentName = task.assignee ?? undefined;

    // Fresh session per run. The task's comments are the durable memory; keeping
    // session history around across runs accumulates stale context (e.g. old
    // "Task blocked. Stop working" messages from the last ask_user call).
    const sessionKey = `autopilot:${task.id}`;
    const { provider, model } = await this.resolveSessionModel(agentName);
    const session = resetSession(db, sessionKey, model, provider);

    const taskWithComments = (await this.tasks.get(task.id)) ?? task;
    const prompt = buildTaskPrompt(taskWithComments);

    // Per-task abort controller: lets us stop *this* task when the budget is hit,
    // without shutting down sibling conversations (chats, other autopilot runs).
    const taskAbort = new AbortController();
    const runtimeSignal = this.runtime.shutdownSignal;
    const onRuntimeAbort = () => taskAbort.abort();
    runtimeSignal.addEventListener("abort", onRuntimeAbort);

    const toolCalls: string[] = [];
    const startedAt = Date.now();
    let promptTokens = 0;
    let completionTokens = 0;

    const loopOpts = this.runtime.buildLoopOptions({ session, agentName });
    try {
      const response = await runAgentLoop(prompt, {
        ...loopOpts,
        signal: taskAbort.signal,
        toolContextExtras: { autopilotTaskId: task.id, agentName },
        onUsage: (usage) => {
          promptTokens += usage.input;
          completionTokens += usage.output;
          recordTokenUsage(db, {
            sessionId: session.id,
            taskId: task.id,
            promptTokens: usage.input,
            completionTokens: usage.output,
          });
          // Mid-task budget check — hard stop at the next LLM-round boundary for this task only.
          const budget = checkBudget(db);
          if (budget.exceeded) {
            taskAbort.abort();
          }
        },
        onToolCall: (name, args) => {
          toolCalls.push(name);
          console.log(`[autopilot] [${task.id}] tool: ${name}(${JSON.stringify(args).slice(0, 200)})`);
        },
      });
      await this.finalizeTask(task, {
        response,
        toolCalls,
        durationMs: Date.now() - startedAt,
        promptTokens,
        completionTokens,
      });
    } finally {
      runtimeSignal.removeEventListener("abort", onRuntimeAbort);
    }
  }

  private async finalizeTask(
    task: Task,
    run: {
      response: string;
      toolCalls: string[];
      durationMs: number;
      promptTokens: number;
      completionTokens: number;
    },
  ): Promise<void> {
    const db = this.runtime.db;
    const agentName = task.assignee ?? "agent";
    const inProgress = this.tasks.statuses.inProgress;

    const finalTask = await this.tasks.get(task.id);
    if (!finalTask) return;

    const settings = getAutopilotSettings(db);
    const budgetNow = checkBudget(db, settings);

    // Budget hit mid-run: system event, authored by autopilot.
    if (budgetNow.exceeded && finalTask.status === inProgress) {
      await this.tasks.update(task.id, { status: this.tasks.statuses.blocked, blocked_reason: "budget" });
      await this.tasks.comment(
        task.id,
        `Paused: token budget exceeded (${budgetNow.window} window: ${budgetNow.usage}/${budgetNow.cap}). Will auto-resume when window rolls.`,
        "autopilot",
      );
      return;
    }

    // Agent finished without transitioning status. That means it either ran out of
    // rounds or replied with text instead of calling tasks(update). Post an
    // agent-authored note capturing whatever text it produced, then force-done.
    if (finalTask.status === inProgress) {
      const content = run.response?.trim()
        ? `Finished without explicitly closing the task. Final note:\n\n${run.response.trim()}`
        : "Finished without explicitly closing the task (no final response). Marking done.";
      await this.tasks.comment(task.id, content, agentName);
      await this.tasks.update(task.id, { status: this.tasks.statuses.done });
    }
    // All other status-change comments were posted by the agent itself via the
    // tasks tool — see TasksTool.update. No extra audit comment needed here.
  }

  private async resolveSessionModel(agentName?: string): Promise<{ provider: string; model: string }> {
    const config = this.runtime.getConfig();
    const agent = agentName ? config.agents?.[agentName] : undefined;
    const model = agent?.model ?? this.runtime.getModel();
    const provider = agent?.provider ?? config.agent.defaultProvider;
    return { provider, model };
  }
}

export function buildTaskPrompt(task: Task): string {
  const lines = [
    `You have picked up task ${task.id}: "${task.title}".`,
    "",
    "RULES:",
    "",
    "1. Read the task description AND all prior comments before doing anything.",
    "   If the user has already told you something in a comment, don't ask again —",
    "   use what you have.",
    "",
    "2. If this task needs a real-world action you have no tool for — booking",
    "   appointments, sending physical mail, making phone calls, placing orders,",
    "   anything requiring a website or API you can't reach — STOP. Do NOT call",
    "   ask_user for more details (that just loops). Instead:",
    "     tasks(action=update, id=\"" + task.id + "\", status=\"in_review\",",
    '       comment="Cannot complete this directly — I don\'t have a tool to',
    '       <action>. Here\'s what I gathered: <summary>. Over to you.")',
    "",
    "3. Only call ask_user when (a) you have a tool that can use the answer AND",
    "   (b) the info isn't already in the description or prior comments.",
    "",
    "4. When you change status, include a `comment` describing what you did or",
    "   why you're blocked — this is the audit log. Example:",
    `     tasks(action=update, id="${task.id}", status="done",`,
    '       comment="Saved a summary of the meeting notes to memory.")',
    "   Use status=in_review instead of done when you\'re uncertain about the",
    "   result.",
    "",
    "Task description:",
    task.description || "(no description — infer intent from the title)",
  ];

  const comments = task.comments ?? [];
  if (comments.length > 0) {
    lines.push("", `Prior activity on this task (${comments.length} comment(s)):`);
    for (const c of comments.slice(-10)) {
      const author = c.author || "unknown";
      const body = c.content.length > 400 ? `${c.content.slice(0, 400)}…` : c.content;
      lines.push(`  [${author}] ${body}`);
    }
    lines.push(
      "",
      "Check the above carefully. If user answers are present, use them — do not",
      "ask the same question again.",
    );
  }

  return lines.join("\n");
}
