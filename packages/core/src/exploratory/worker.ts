import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentDefinition, OnlineAgentConfig } from "../config.js";
import { runAgentLoop } from "../agent/loop.js";
import { resetSession } from "../agent/session.js";
import { isInTimeWindow } from "../db/autopilot-queries.js";
import { recordTokenUsage } from "../db/autopilot-queries.js";
import {
  completeExploratoryRun,
  createExploratoryRun,
  ensureExploratoryState,
  type ExploratoryRun,
  type ExploratoryRunStatus,
  type ExploratoryState,
  listExploratoryStates,
  maybeResetDailyCounters,
  updateExploratoryState,
} from "../db/exploratory-queries.js";
import { createNote, listNotes } from "../db/note-queries.js";
import { appendTickLog } from "../db/tick-log-queries.js";
import { detectStall } from "../task-watcher.js";
import { SleepTool } from "../tools/sleep.js";
import type { AgentRuntime } from "../runtime.js";
import { buildTickContext, renderTickSituation } from "./tick-context.js";

export interface ExploratoryWorkerOptions {
  runtime: AgentRuntime;
  /** How often the worker scans for due agents, in ms. Default 60_000. */
  intervalMs?: number;
  /** Injectable clock for testability. */
  now?: () => Date;
  /** Hook called when a tick *would* run an agent. */
  onWouldRun?: (info: { agentName: string; reason: string }) => void;
  /** Hook called when a tick was skipped, with the reason. */
  onSkip?: (info: { agentName: string; reason: string }) => void;
  /** Hook called when an agent run finishes. Used by tests + UI. */
  onRunFinished?: (run: ExploratoryRun) => void;
  /**
   * Override the loop runner. Useful for tests that don't want to spin up a
   * provider; defaults to `runAgentLoop` from `../agent/loop.js`.
   */
  runLoop?: typeof runAgentLoop;
}

export interface ExploratoryActivity {
  agentName: string;
  runId: string;
  startedAt: string;
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_TICK_INTERVAL_MINUTES = 30;
const DEFAULT_MAX_INTERVAL_MINUTES = 240;
const DEFAULT_IDLE_BACKOFF_MULTIPLIER = 2.0;
// Budgets are opt-in: when a `budgets:` field is omitted from an agent's
// online block, no cap is enforced. Set explicit values to gate runaway
// ticks; leave the block off entirely to run unrestricted.

export type SkipReason =
  | "config-disabled"
  | "agent-online-disabled"
  | "state-disabled"
  | "paused"
  | "outside-window"
  | "runs-cap-reached"
  | "cadence-not-elapsed";

/**
 * A3 — wires the agent loop into the worker shell from A2. Each due tick now
 * actually runs the agent against a recall-built prompt with narrowed tools,
 * abort + tokens-per-tick guard, and records an `xrun_*` row.
 */
export class ExploratoryWorker {
  private runtime: AgentRuntime;
  private intervalMs: number;
  private now: () => Date;
  private timer: ReturnType<typeof setInterval> | undefined;
  private currentActivity: ExploratoryActivity | undefined;
  private running = false;
  private onWouldRun?: ExploratoryWorkerOptions["onWouldRun"];
  private onSkip?: ExploratoryWorkerOptions["onSkip"];
  private onRunFinished?: ExploratoryWorkerOptions["onRunFinished"];
  private runLoop: typeof runAgentLoop;

  constructor(opts: ExploratoryWorkerOptions) {
    this.runtime = opts.runtime;
    this.intervalMs =
      opts.intervalMs ?? this.runtime.getConfig().exploratory?.baseIntervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = opts.now ?? (() => new Date());
    this.onWouldRun = opts.onWouldRun;
    this.onSkip = opts.onSkip;
    this.onRunFinished = opts.onRunFinished;
    this.runLoop = opts.runLoop ?? runAgentLoop;
  }

  start(): void {
    if (this.timer) return;
    const cfg = this.runtime.getConfig().exploratory;
    if (!cfg?.enabled) {
      console.log(`[exploratory] disabled in config — worker not started`);
      return;
    }
    console.log(`[exploratory] started (interval ${this.intervalMs}ms)`);
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        console.error(`[exploratory] tick error:`, err);
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      console.log(`[exploratory] stopped`);
    }
  }

  getActivity(): ExploratoryActivity | undefined {
    return this.currentActivity;
  }

  /** Public for tests / manual triggers. */
  async tick(): Promise<void> {
    if (this.running) return; // never re-enter
    const config = this.runtime.getConfig();
    if (!config.exploratory?.enabled) {
      this.skip("(global)", "config-disabled");
      return;
    }
    this.running = true;
    try {
      const agents = config.agents ?? {};
      const now = this.now();
      for (const [name, def] of Object.entries(agents)) {
        const decision = this.evaluate(name, def, now);
        if (decision.kind === "skip") {
          this.skip(name, decision.reason);
          continue;
        }
        this.onWouldRun?.({ agentName: name, reason: decision.reason });
        try {
          await this.runAgent(name, def);
        } catch (err) {
          console.error(`[exploratory] ${name} run failed:`, (err as Error).message);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Run a single agent. Public for tests/manual triggers, but normally driven
   * by `tick()`.
   */
  async runAgent(agentName: string, def: AgentDefinition): Promise<ExploratoryRun> {
    const db = this.runtime.db;
    const online = def.online ?? {};
    const projectId = this.runtime.getConfig().exploratory ? null : null; // S7: project-scoped exploratory deferred
    const run = createExploratoryRun(db, { agentName, projectId });
    this.currentActivity = {
      agentName,
      runId: run.id,
      startedAt: run.started_at,
    };

    // Snapshot pre-run state — anything created with created_at >= cutoffIso
    // and matching the agent (notes) is attributed to this run.
    const cutoffIso = (db.prepare("SELECT datetime('now') AS t").get() as { t: string }).t;

    let status: ExploratoryRunStatus = "ok";
    let summary: string | undefined;
    let errorMsg: string | undefined;
    let promptTokens = 0;
    let completionTokens = 0;
    const toolCalls: string[] = [];
    const startedAt = Date.now();

    const abortController = new AbortController();
    const runtimeSignal = this.runtime.shutdownSignal;
    const onRuntimeAbort = () => abortController.abort();
    runtimeSignal.addEventListener("abort", onRuntimeAbort);

    // Budgets are opt-in. Missing values fall back to the agent's normal
    // reactive limits (token use untracked, maxToolRounds from baseOpts below).
    const tokenCap = online.budgets?.tokens_per_tick ?? Number.POSITIVE_INFINITY;
    const explicitToolCallCap = online.budgets?.tool_calls_per_tick;

    try {
      const basePrompt = await this.buildTickPrompt(agentName, def);

      // Build a structured "Situation" block from live state (backlog,
      // outcomes-window, exploration candidates from core_memory). The
      // agent picks from a typed candidate menu instead of free-styling
      // "what should I do" (docs/agent-unification.md, Phase 3).
      const tickCtx = buildTickContext(db, agentName, projectId);
      const situation = renderTickSituation(tickCtx);
      const prompt = `${basePrompt}\n\n${situation}`;

      const sessionKey = `exploratory:${agentName}:${run.id}`;
      const provider = this.runtime.getProvider().id;
      const model = this.runtime.getModel();
      const session = resetSession(db, sessionKey, model, provider, null);

      // Sleep tool is only available inside ticks — passed via extraTools
      // so reactive chat never sees it (silent agent mid-conversation = bad UX).
      const sleepTool = new SleepTool(db);
      const baseOpts = this.runtime.buildLoopOptions({
        session,
        agentName,
        extraTools: [sleepTool],
      });

      // Narrow the tool set if the agent declared online.tools (a subset of
      // its main tools). Subset semantics: each entry must be a name in
      // baseOpts.tools. Meta tools (delegate, run_workflow, task_status,
      // admin, …) are always kept regardless of the allowlist — they're
      // unconditionally available in reactive mode too, and stripping them
      // during ticks breaks orchestration patterns that delegate to
      // specialists or invoke workflows.
      let tools = baseOpts.tools;
      let getTools = baseOpts.getTools;
      if (online.tools && online.tools.length > 0) {
        const want = new Set(online.tools);
        const metaNames = new Set(this.runtime.getMetaTools().map((t) => t.name));
        // Sleep is the noop terminator — must survive any allowlist or the
        // agent has no way to end a tick cleanly (it would have to fall back
        // to writing a "tick: idle" recall note, which is exactly the
        // antipattern we're trying to kill).
        const alwaysKeep = new Set(["Sleep"]);
        const keep = (t: { name: string }) =>
          want.has(t.name) || metaNames.has(t.name) || alwaysKeep.has(t.name);
        tools = baseOpts.tools.filter(keep);
        getTools = () => (baseOpts.getTools?.() ?? tools).filter(keep);
      }

      // When no per-tick tool-call budget is set, fall back to the agent's
      // normal reactive maxToolRounds rather than capping at a magic number.
      const toolCallCap = explicitToolCallCap ?? baseOpts.maxToolRounds ?? Number.POSITIVE_INFINITY;

      const response = await this.runLoop(prompt, {
        ...baseOpts,
        tools,
        getTools,
        maxToolRounds: toolCallCap,
        signal: abortController.signal,
        toolContextExtras: { agentName, exploratoryRunId: run.id },
        onUsage: (usage) => {
          promptTokens += usage.input;
          completionTokens += usage.output;
          recordTokenUsage(db, {
            sessionId: session.id,
            promptTokens: usage.input,
            completionTokens: usage.output,
          });
          if (promptTokens + completionTokens >= tokenCap) {
            console.log(
              `[exploratory] ${agentName} hit per-tick token cap (${tokenCap}) — aborting`,
            );
            status = "budget";
            abortController.abort();
          }
        },
        onToolCall: (name) => {
          toolCalls.push(name);
        },
      });
      summary = response.slice(0, 1000);
    } catch (err) {
      const msg = (err as Error).message;
      if (abortController.signal.aborted && status === "ok") {
        status = "budget";
      } else if (status === "ok") {
        status = "error";
        errorMsg = msg;
      }
      console.error(`[exploratory] ${agentName} run ${run.id}: ${msg}`);
    } finally {
      runtimeSignal.removeEventListener("abort", onRuntimeAbort);
    }

    // Stall detection. When the loop returns `[Agent stopped: …]` (max
    // rounds, repeated identical calls, shutdown), the exploratory worker
    // previously classified it as "noop" because no outputs were produced
    // — burying the failure. Now we reclassify to `error`, leave a recall
    // note tagged `stall` so the agent sees it next tick, and bump the
    // backoff so we don't immediately retry the same stuck shape.
    // task-watcher has its own stall recovery (retry-then-block); this is
    // the analog for exploratory ticks.
    const stallReason = detectStall(summary ?? "");
    if (stallReason) {
      status = "error";
      errorMsg = `loop-stalled: ${stallReason}`;
      try {
        createNote(db, {
          agent: agentName,
          project_id: projectId,
          content:
            `Previous tick stalled with "${stallReason}". ` +
            `Likely cause: too much exploration with no commit/exit. ` +
            `Next tick: pick a smaller scope, or write a status note and Sleep early.`,
          tags: ["stall", "self-feedback"],
          importance: 0.8,
        });
      } catch (err) {
        console.error(`[exploratory] failed to record stall note: ${(err as Error).message}`);
      }
      console.error(
        `[exploratory] ${agentName} stalled (${stallReason}); recorded self-feedback note`,
      );
    }

    // Detect outputs created during this run (agent-scoped notes; project_id
    // and global facts/tasks by cutoff). Drives the noop/ok classification.
    const outputs = this.detectOutputs(agentName, cutoffIso);

    // Only reclassify ok ↔ noop. error/budget/stall statuses stand as-is.
    if (status === "ok" && outputs.totalCount === 0) {
      status = "noop";
    }

    const completed = completeExploratoryRun(db, run.id, {
      status,
      tokensUsed: promptTokens + completionTokens,
      toolCalls: toolCalls.length,
      noteIds: outputs.noteIds,
      factIds: outputs.factIds,
      taskIds: outputs.taskIds,
      summary,
      error: errorMsg,
    });

    // Mirror the run's outcome into tick_log so it's queryable as
    // operational telemetry without joining recall (docs/agent-unification.md).
    // Status → kind mapping: ok→material, noop→noop, error/budget→error.
    const tickKind =
      status === "ok" ? "material"
      : status === "noop" ? "noop"
      : "error";
    appendTickLog(db, {
      tick_id: run.id,
      agent: agentName,
      project_id: projectId,
      kind: tickKind,
      summary,
      payload: {
        tokens: promptTokens + completionTokens,
        tool_calls: toolCalls.length,
        notes: outputs.noteIds.length,
        facts: outputs.factIds.length,
        tasks: outputs.taskIds.length,
        error: errorMsg ?? undefined,
      },
    });

    // Update state counters. Daily counters were reset at the top of evaluate().
    const state = ensureExploratoryState(db, agentName);
    const nextInterval = this.computeNextInterval(state, online, status);
    updateExploratoryState(db, agentName, {
      last_tick_at: new Date(startedAt).toISOString(),
      last_tick_status: status,
      runs_today: state.runs_today + 1,
      tokens_today: state.tokens_today + (promptTokens + completionTokens),
      current_interval_ms: nextInterval,
    });

    this.currentActivity = undefined;
    this.onRunFinished?.(completed);
    return completed;
  }

  /**
   * Snapshot of artifacts created during a run. Notes use the agent column so
   * concurrent agent activity on the same db doesn't bleed in; facts and
   * project tasks are attributed by timestamp only (best-effort).
   */
  private detectOutputs(
    agentName: string,
    cutoffIso: string,
  ): {
    noteIds: string[];
    factIds: string[];
    taskIds: string[];
    totalCount: number;
  } {
    const db = this.runtime.db;
    const noteRows = db
      .prepare(
        "SELECT id FROM notes WHERE agent = ? AND datetime(created_at) >= datetime(?) ORDER BY created_at ASC",
      )
      .all(agentName, cutoffIso) as Array<{ id: string }>;
    const factRows = db
      .prepare(
        "SELECT id FROM facts WHERE datetime(created_at) >= datetime(?) ORDER BY created_at ASC",
      )
      .all(cutoffIso) as Array<{ id: string }>;
    const taskRows = db
      .prepare(
        "SELECT id FROM project_tasks WHERE datetime(created_at) >= datetime(?) ORDER BY created_at ASC",
      )
      .all(cutoffIso) as Array<{ id: string }>;
    const noteIds = noteRows.map((r) => r.id);
    const factIds = factRows.map((r) => r.id);
    const taskIds = taskRows.map((r) => r.id);
    return {
      noteIds,
      factIds,
      taskIds,
      totalCount: noteIds.length + factIds.length + taskIds.length,
    };
  }

  /**
   * Idle backoff. Activity (ok) resets to base; no-op multiplies the current
   * interval by `idle_backoff_multiplier` (default 2.0), capped at
   * `max_interval_minutes`. error / budget statuses leave the interval alone.
   */
  private computeNextInterval(
    state: ExploratoryState,
    online: OnlineAgentConfig,
    status: ExploratoryRunStatus,
  ): number | null {
    const cadence = online.cadence;
    const baseMs = (cadence?.interval_minutes ?? DEFAULT_TICK_INTERVAL_MINUTES) * 60_000;
    const maxMs = (cadence?.max_interval_minutes ?? DEFAULT_MAX_INTERVAL_MINUTES) * 60_000;
    const multiplier = cadence?.idle_backoff_multiplier ?? DEFAULT_IDLE_BACKOFF_MULTIPLIER;

    if (status === "ok") {
      // Reset to base by clearing the override.
      return null;
    }
    if (status === "noop") {
      const current = state.current_interval_ms && state.current_interval_ms > 0
        ? state.current_interval_ms
        : baseMs;
      // In-window cap: during the agent's working window, the user expects
      // periodic activity. A 2h backoff (the default max) means the agent
      // effectively goes silent for hours after a single quiet stretch.
      // Cap in-window backoff at 4x the base interval; out-of-window can
      // still stretch all the way to max_interval_minutes.
      const inWindow = cadence?.window
        ? isInTimeWindow(cadence.window.start, cadence.window.end, this.now())
        : true;
      const effectiveMax = inWindow ? Math.min(maxMs, baseMs * 4) : maxMs;
      const next = Math.min(Math.round(current * multiplier), effectiveMax);
      return next;
    }
    // error / budget — leave the current interval alone.
    return state.current_interval_ms ?? null;
  }

  /**
   * Build the per-tick prompt. Layers: goals.md text + recent recall results +
   * a fixed pick-one-thing instruction.
   */
  async buildTickPrompt(agentName: string, def: AgentDefinition): Promise<string> {
    const goals = await this.readGoals(agentName, def);
    const recall = await this.readRecentRecall(agentName);
    const sections: string[] = [];
    sections.push("[Goals]");
    sections.push(goals.trim() || "(no goals.md — agent should re-read its own instructions)");
    sections.push("");
    sections.push("[Recent notes]");
    sections.push(recall || "(no recent notes)");
    sections.push("");
    sections.push(
      "Pick the single most useful thing to do this tick toward those goals. " +
        "If nothing new is worth doing, write a brief note explaining why and stop.",
    );
    return sections.join("\n");
  }

  private async readGoals(agentName: string, def: AgentDefinition): Promise<string> {
    const file = def.online?.goals_file ?? "goals.md";
    const agentContextDir = def.contextDir ?? join(this.runtime.contextDir, "agents", agentName);
    const path = join(agentContextDir, file);
    try {
      return await readFile(path, "utf8");
    } catch {
      return "";
    }
  }

  private async readRecentRecall(agentName: string): Promise<string> {
    try {
      const notes = listNotes(this.runtime.db, {
        agent: agentName,
        limit: 5,
        excludeExpired: true,
      });
      if (notes.length === 0) return "";
      return notes
        .map((n) => {
          const stamp = n.created_at.slice(0, 16).replace("T", " ");
          const tags = n.tags.length > 0 ? ` [${n.tags.join(",")}]` : "";
          return `- ${stamp}${tags}: ${n.content.slice(0, 200)}`;
        })
        .join("\n");
    } catch (err) {
      console.warn(`[exploratory] recall failed: ${(err as Error).message}`);
      return "";
    }
  }

  evaluate(
    agentName: string,
    def: AgentDefinition,
    now: Date = this.now(),
  ): { kind: "skip"; reason: SkipReason } | { kind: "run"; reason: string } {
    const online = def.online;
    if (!online?.enabled) return { kind: "skip", reason: "agent-online-disabled" };

    const state = maybeResetDailyCounters(this.runtime.db, agentName);
    if (!state.enabled) return { kind: "skip", reason: "state-disabled" };

    if (state.paused_until) {
      const paused = new Date(state.paused_until);
      if (!Number.isNaN(paused.getTime()) && paused.getTime() > now.getTime()) {
        return { kind: "skip", reason: "paused" };
      }
    }

    if (online.cadence?.window) {
      const { start, end } = online.cadence.window;
      if (!isInTimeWindow(start, end, now)) {
        return { kind: "skip", reason: "outside-window" };
      }
    }

    const runsCap = online.budgets?.stop_after_runs_per_day ?? Number.POSITIVE_INFINITY;
    if (state.runs_today >= runsCap) {
      return { kind: "skip", reason: "runs-cap-reached" };
    }

    if (!this.cadenceElapsed(state, online, now)) {
      return { kind: "skip", reason: "cadence-not-elapsed" };
    }

    return { kind: "run", reason: "due" };
  }

  private cadenceElapsed(state: ExploratoryState, online: OnlineAgentConfig, now: Date): boolean {
    if (!state.last_tick_at) return true;
    const last = new Date(state.last_tick_at);
    if (Number.isNaN(last.getTime())) return true;
    const intervalMs = this.effectiveIntervalMs(state, online);
    return now.getTime() - last.getTime() >= intervalMs;
  }

  private effectiveIntervalMs(state: ExploratoryState, online: OnlineAgentConfig): number {
    if (state.current_interval_ms && state.current_interval_ms > 0) {
      return state.current_interval_ms;
    }
    const base = (online.cadence?.interval_minutes ?? DEFAULT_TICK_INTERVAL_MINUTES) * 60_000;
    const max = (online.cadence?.max_interval_minutes ?? DEFAULT_MAX_INTERVAL_MINUTES) * 60_000;
    return Math.min(base, max);
  }

  private skip(agentName: string, reason: SkipReason | string): void {
    this.onSkip?.({ agentName, reason });
  }

  /** Convenience: list state for every agent that's ever been touched. */
  listStates(): ExploratoryState[] {
    return listExploratoryStates(this.runtime.db);
  }

  /** Convenience: initialize a state row if the agent hasn't ticked yet. */
  primeState(agentName: string): ExploratoryState {
    return ensureExploratoryState(this.runtime.db, agentName);
  }
}
