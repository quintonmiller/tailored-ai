import { Cron } from "croner";
import { runAgentLoop } from "../agent/loop.js";
import { runMemorySweep } from "../agent/memory-promotion.js";
import { resetSession } from "../agent/session.js";
import { checkBudget, getAutopilotSettings, isInDisabledHours } from "../db/autopilot-queries.js";
import { findStuckCodingTasks } from "../db/task-queries.js";
import type { ProjectRef } from "../projects/resolve.js";
import type { AgentRuntime } from "../runtime.js";
import type { Task, TaskBackend } from "../tasks/interface.js";
import { buildMorningDigest, recordDigestRun } from "./digest.js";
import { buildTaskPrompt } from "./task-prompt.js";

// Re-export so existing importers (index.ts, tests) keep resolving
// buildTaskPrompt / DEFAULT_AUTOPILOT_TASK_PROMPT from the worker module.
export { buildTaskPrompt, DEFAULT_AUTOPILOT_TASK_PROMPT } from "./task-prompt.js";

export interface StuckTaskWatcher {
  notify(
    event: { action: "updated"; task: import("../db/task-queries.js").ProjectTask },
    opts?: { force?: boolean },
  ): void;
}

export interface AutopilotWorkerOptions {
  runtime: AgentRuntime;
  /** How often (ms) to poll for new work. Default 30s. */
  intervalMs?: number;
  /** Emits when the worker picks up or finishes a task. UI uses this for the "working on" strip. */
  onActivity?: (activity: { taskId: string; title: string } | null) => void;
  /** Override the task backend. Defaults to `createTaskBackend(runtime.getConfig(), runtime.db)`. */
  taskBackend?: TaskBackend;
  /**
   * Lookup for the live TaskWatcher so the stuck-task scanner can re-fire
   * stalled coding tasks. Returning undefined disables the scanner (e.g.
   * for tests, or when the watcher hasn't been built yet).
   */
  getTaskWatcher?: () => StuckTaskWatcher | undefined;
  /** Override the stuck-task scan interval (ms). Default 15 min. */
  stuckScanIntervalMs?: number;
  /** Override the staleness threshold (ms). Tasks older than this with an agent assignee are considered stuck. Default 30 min. */
  stuckThresholdMs?: number;
}

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_STUCK_SCAN_INTERVAL_MS = 15 * 60_000;
const DEFAULT_STUCK_THRESHOLD_MS = 30 * 60_000;

const WORKFLOW_TAG_PREFIX = "workflow:";

function findWorkflowTag(tags: string[]): string | null {
  for (const tag of tags) {
    if (typeof tag === "string" && tag.startsWith(WORKFLOW_TAG_PREFIX)) {
      return tag.slice(WORKFLOW_TAG_PREFIX.length).trim() || null;
    }
  }
  return null;
}

export class AutopilotWorker {
  private runtime: AgentRuntime;
  private intervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private digestCron: Cron | undefined;
  private memorySweepCron: Cron | undefined;
  private stuckScanTimer: ReturnType<typeof setInterval> | undefined;
  private currentDigestTime: string | null = null;
  private running = false;
  private currentTask: { taskId: string; title: string } | undefined;
  private onActivity?: (activity: { taskId: string; title: string } | null) => void;
  private getTaskWatcher?: () => StuckTaskWatcher | undefined;
  private stuckScanIntervalMs: number;
  private stuckThresholdMs: number;
  private tasks: TaskBackend;

  constructor(opts: AutopilotWorkerOptions) {
    this.runtime = opts.runtime;
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.onActivity = opts.onActivity;
    this.getTaskWatcher = opts.getTaskWatcher;
    this.stuckScanIntervalMs = opts.stuckScanIntervalMs ?? DEFAULT_STUCK_SCAN_INTERVAL_MS;
    this.stuckThresholdMs = opts.stuckThresholdMs ?? DEFAULT_STUCK_THRESHOLD_MS;
    this.tasks = opts.taskBackend ?? this.runtime.getTaskBackend();
  }

  start(): void {
    if (this.timer) return;
    console.log(`[autopilot] Started (interval ${this.intervalMs}ms)`);
    if (this.tasks.bootstrap) {
      this.tasks
        .bootstrap()
        .then((r) => {
          if (r.created.length > 0) {
            console.log(`[autopilot] Bootstrapped ${this.tasks.name} backend: created ${r.created.join(", ")}`);
          }
        })
        .catch((err) => {
          console.warn(`[autopilot] ${this.tasks.name} bootstrap failed:`, (err as Error).message);
        });
    }
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        console.error("[autopilot] Tick error:", (err as Error).message);
      });
    }, this.intervalMs);
    this.syncDigestSchedule();
    this.startMemorySweepCron();
    this.startStuckTaskScan();
    // Fire once immediately.
    this.tick().catch((err) => {
      console.error("[autopilot] Initial tick error:", (err as Error).message);
    });
  }

  /**
   * Periodically scan for agent-assigned tasks (assignee is any known
   * agent) whose updated_at is older than the staleness threshold
   * and that haven't reached a terminal status. For each stuck task we
   * re-fire the watcher event with `force: true` — the watcher's stall
   * handling (handleStall) then decides retry vs block based on prior
   * STALL comments. Without this scan, a task whose dispatched run died
   * silently (e.g. the process was restarted mid-loop) would never be
   * picked up again.
   */
  private startStuckTaskScan(): void {
    if (this.stuckScanTimer) return;
    if (!this.getTaskWatcher) {
      console.log("[autopilot] Stuck-task scan disabled (no taskWatcher accessor)");
      return;
    }
    this.stuckScanTimer = setInterval(() => {
      this.scanStuckTasks().catch((err) => {
        console.error("[autopilot] Stuck-task scan error:", (err as Error).message);
      });
    }, this.stuckScanIntervalMs);
    console.log(
      `[autopilot] Stuck-task scan scheduled every ${Math.round(this.stuckScanIntervalMs / 60_000)}m ` +
        `(threshold ${Math.round(this.stuckThresholdMs / 60_000)}m)`,
    );
  }

  /** One pass of the stuck-task scanner. Public for the autopilot-stuck-scan test. */
  async scanStuckTasks(): Promise<{ requeued: number; skipped: number }> {
    const watcher = this.getTaskWatcher?.();
    if (!watcher) return { requeued: 0, skipped: 0 };
    // Timer-driven re-dispatch. `notify(..., {force: true})` deliberately
    // bypasses the assignee gate, so without this a pause would leave the one
    // path that re-fires the same agent over and over still running.
    if (this.runtime.isAgentsPaused("autonomous")) return { requeued: 0, skipped: 0 };
    const config = this.runtime.getConfig();
    const knownAgents = Object.keys(config.agents ?? {});
    if (knownAgents.length === 0) return { requeued: 0, skipped: 0 };

    const stuck = findStuckCodingTasks(this.runtime.db, {
      assignees: knownAgents,
      thresholdMs: this.stuckThresholdMs,
    });
    let requeued = 0;
    for (const task of stuck) {
      console.log(
        `[autopilot] Re-firing stuck task ${task.id} (assignee=${task.assignee}, status=${task.status}, ` +
          `updated_at=${task.updated_at})`,
      );
      watcher.notify({ action: "updated", task }, { force: true });
      requeued++;
    }
    return { requeued, skipped: 0 };
  }

  /**
   * Daily memory hygiene sweep — extends TTL on referenced notes and deletes
   * expired low-importance ones. Schedule comes from
   * `autopilot.memorySweepCron`; an empty value disables the sweep.
   */
  private startMemorySweepCron(): void {
    if (this.memorySweepCron) return;
    const schedule = this.runtime.getConfig().autopilot?.memorySweepCron;
    if (!schedule) {
      console.log("[autopilot] Memory sweep disabled (autopilot.memorySweepCron is empty)");
      return;
    }
    try {
      this.memorySweepCron = new Cron(schedule, () => {
        try {
          const report = runMemorySweep(this.runtime.db);
          console.log(
            `[autopilot] Memory sweep: extended ${report.extendedTtl}, deleted ${report.deletedExpired}, ` +
              `remaining notes=${report.remainingNotes}, chunks=${report.totalChunks}`,
          );
        } catch (err) {
          console.error("[autopilot] Memory sweep error:", (err as Error).message);
        }
      });
    } catch (err) {
      console.warn(
        `[autopilot] Invalid autopilot.memorySweepCron "${schedule}": ${(err as Error).message}; memory sweep disabled`,
      );
      return;
    }
    console.log(`[autopilot] Memory sweep scheduled (${schedule})`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.digestCron) {
      this.digestCron.stop();
      this.digestCron = undefined;
    }
    if (this.memorySweepCron) {
      this.memorySweepCron.stop();
      this.memorySweepCron = undefined;
    }
    if (this.stuckScanTimer) {
      clearInterval(this.stuckScanTimer);
      this.stuckScanTimer = undefined;
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

    // Delivery is owned by the `builtin:owner-notifier` plugin (or any
    // subscriber a user wires up): emit the digest as an event rather than
    // DMing the owner inline.
    this.runtime.events.emit("digest.ready", { content: digest.content, periodLabel: "Morning" });
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
    // Autopilot's own pause switch covers autopilot. This one covers the whole
    // deployment, so the owner does not have to remember which of six things
    // is running in order to stop the spending.
    if (this.runtime.isAgentsPaused("autonomous")) return;
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
      // Delivery (and quiet-hours suppression) is owned by the
      // `builtin:owner-notifier` plugin: emit the event rather than DMing inline.
      this.runtime.events.emit("task.needs_human", {
        taskId: claimed.id,
        agentName: claimed.assignee ?? undefined,
        reason: "error",
        message: `Task ${claimed.id} errored: ${claimed.title}\n${msg}`,
      });
    } finally {
      this.currentTask = undefined;
      this.onActivity?.(null);
    }
  }

  /**
   * Resolve a task's `project_id` to a `ProjectRef` if the project is registered
   * with a path. Returns null for global/legacy tasks so they run in the host cwd.
   */
  private resolveTaskProject(task: Task): ProjectRef | null {
    if (!task.project_id) return null;
    return this.runtime.getProjectByName(task.project_id) ?? null;
  }

  private async runTask(task: Task): Promise<void> {
    const db = this.runtime.db;
    const agentName = task.assignee ?? undefined;

    const taskWithComments = (await this.tasks.get(task.id)) ?? task;

    // Workflow trigger: when a task tag matches "workflow:<name>" and the
    // workflow is registered, route through the engine instead of the
    // standard agent loop.
    const workflowName = findWorkflowTag(taskWithComments.tags);
    if (workflowName) {
      const engine = this.runtime.getWorkflowEngine();
      const reg = this.runtime.getWorkflows().get(workflowName);
      if (engine && reg) {
        await this.runTaskViaWorkflow(task, taskWithComments, agentName, workflowName);
        return;
      }
      console.warn(
        `[autopilot] task ${task.id} tagged workflow:${workflowName} but ${
          !engine ? "no engine configured" : "workflow not registered"
        } — falling back to agent loop`,
      );
    }

    // Resolve the project context from task.project_id. Tasks tied to a registered
    // project run in that project's path; tasks with no project_id (or pointing at
    // an unregistered/legacy "Default" project) run in the host cwd.
    const projectCtx = this.resolveTaskProject(task);

    // Fresh session per run. The task's comments are the durable memory; keeping
    // session history around across runs accumulates stale context (e.g. old
    // "Task blocked. Stop working" messages from the last ask_user call).
    const sessionKey = `autopilot:${task.id}`;
    const { provider, model } = await this.resolveSessionModel(agentName);
    const session = resetSession(db, sessionKey, model, provider, projectCtx?.id ?? null);

    const prompt = buildTaskPrompt(taskWithComments, this.runtime.getConfig().autopilot?.taskPrompt);

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

    const loopOpts = this.runtime.buildLoopOptions({ session, agentName, project: projectCtx });
    try {
      const response = await runAgentLoop(prompt, {
        ...loopOpts,
        signal: taskAbort.signal,
        toolContextExtras: { autopilotTaskId: task.id, agentName },
        usageSource: "autopilot",
        usageTaskId: task.id,
        // The loop records the token_usage row now; this callback only keeps
        // the running total and enforces the mid-task budget stop.
        onUsage: (usage) => {
          promptTokens += usage.input;
          completionTokens += usage.output;
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

  private async runTaskViaWorkflow(
    task: Task,
    taskWithComments: Task,
    agentName: string | undefined,
    workflowName: string,
  ): Promise<void> {
    const engine = this.runtime.getWorkflowEngine();
    if (!engine) return;

    const startedAt = Date.now();
    console.log(`[autopilot] [${task.id}] -> workflow:${workflowName}`);
    try {
      const run = await engine.runWorkflow(workflowName, { task: taskWithComments, agent: agentName ?? null }, "tool");
      const response =
        run.status === "completed"
          ? typeof run.output === "string"
            ? run.output
            : JSON.stringify(run.output ?? null)
          : `[workflow ${run.status}: ${run.error ?? "no error message"}]`;
      await this.finalizeTask(task, {
        response,
        toolCalls: [`workflow:${workflowName}`],
        durationMs: Date.now() - startedAt,
        promptTokens: 0,
        completionTokens: 0,
      });
    } catch (err) {
      console.error(`[autopilot] workflow ${workflowName} threw for task ${task.id}: ${(err as Error).message}`);
      await this.finalizeTask(task, {
        response: `[workflow error: ${(err as Error).message}]`,
        toolCalls: [`workflow:${workflowName}`],
        durationMs: Date.now() - startedAt,
        promptTokens: 0,
        completionTokens: 0,
      });
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
      // Announce the transition the backend update performed so subscribers
      // (e.g. the verify-gate) treat this force-finalize the same as an
      // agent-driven `done`. The TasksTool emits this for agent calls; the
      // worker writes the backend directly, so it must announce its own.
      this.runtime.events.emit("task.transitioned", {
        taskId: task.id,
        projectId: finalTask.project_id ?? undefined,
        from: inProgress,
        to: this.tasks.statuses.done,
        assignee: finalTask.assignee ?? null,
      });
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
