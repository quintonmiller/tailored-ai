import type { AgentDefinition, OnlineAgentConfig } from "../config.js";
import { isInTimeWindow } from "../db/autopilot-queries.js";
import {
  ensureExploratoryState,
  type ExploratoryState,
  listExploratoryStates,
  maybeResetDailyCounters,
  updateExploratoryState,
} from "../db/exploratory-queries.js";
import type { AgentRuntime } from "../runtime.js";

export interface ExploratoryWorkerOptions {
  runtime: AgentRuntime;
  /** How often the worker scans for due agents, in ms. Default 60_000. */
  intervalMs?: number;
  /** Injectable clock for testability. */
  now?: () => Date;
  /** Hook called when a tick *would* run an agent. Used by A2 (dry-run) and tests. */
  onWouldRun?: (info: { agentName: string; reason: string }) => void;
  /** Hook called when a tick was skipped, with the reason. */
  onSkip?: (info: { agentName: string; reason: string }) => void;
}

export interface ExploratoryActivity {
  agentName: string;
  startedAt: string;
  runId?: string;
}

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_TICK_INTERVAL_MINUTES = 30;
const DEFAULT_MAX_INTERVAL_MINUTES = 240;
const DEFAULT_RUNS_PER_DAY_CAP = 12;

export type SkipReason =
  | "config-disabled"
  | "agent-online-disabled"
  | "state-disabled"
  | "paused"
  | "outside-window"
  | "runs-cap-reached"
  | "cadence-not-elapsed";

/**
 * A2 — worker shell. The class wakes on `intervalMs`, scans agents with
 * `online.enabled`, and for each due agent it currently *logs* what it would
 * do without actually running the agent loop. A3 wires the loop in.
 */
export class ExploratoryWorker {
  private runtime: AgentRuntime;
  private intervalMs: number;
  private now: () => Date;
  private timer: ReturnType<typeof setInterval> | undefined;
  private activity: ExploratoryActivity | undefined;
  private onWouldRun?: ExploratoryWorkerOptions["onWouldRun"];
  private onSkip?: ExploratoryWorkerOptions["onSkip"];

  constructor(opts: ExploratoryWorkerOptions) {
    this.runtime = opts.runtime;
    this.intervalMs =
      opts.intervalMs ?? this.runtime.getConfig().exploratory?.baseIntervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = opts.now ?? (() => new Date());
    this.onWouldRun = opts.onWouldRun;
    this.onSkip = opts.onSkip;
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
    return this.activity;
  }

  /** Public for tests / manual triggers. */
  async tick(): Promise<void> {
    const config = this.runtime.getConfig();
    if (!config.exploratory?.enabled) {
      this.skip("(global)", "config-disabled");
      return;
    }
    const agents = config.agents ?? {};
    const now = this.now();
    for (const [name, def] of Object.entries(agents)) {
      const decision = this.evaluate(name, def, now);
      if (decision.kind === "skip") {
        this.skip(name, decision.reason);
        continue;
      }
      // A2: don't actually run; emit "would run" and stamp last_tick_at so
      // we don't burn cycles re-evaluating the same agent every tick.
      this.wouldRun(name, decision.reason);
      updateExploratoryState(this.runtime.db, name, {
        last_tick_at: now.toISOString(),
        last_tick_status: "noop",
      });
    }
  }

  /**
   * Decide whether `agentName` should fire on a tick at `now`. Exposed for
   * tests so the worker logic can be exercised without the timer.
   */
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

    const runsCap = online.budgets?.stop_after_runs_per_day ?? DEFAULT_RUNS_PER_DAY_CAP;
    if (state.runs_today >= runsCap) {
      return { kind: "skip", reason: "runs-cap-reached" };
    }

    if (!this.cadenceElapsed(state, online, now)) {
      return { kind: "skip", reason: "cadence-not-elapsed" };
    }

    return { kind: "run", reason: "due" };
  }

  /** Effective interval for the next tick: backoff or base. */
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

  private wouldRun(agentName: string, reason: string): void {
    console.log(`[exploratory] would-run ${agentName} (${reason})`);
    this.onWouldRun?.({ agentName, reason });
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
