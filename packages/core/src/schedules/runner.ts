/**
 * Fires the wakes agents booked for themselves.
 *
 * **One poll tick, not a timer per schedule.** A `setInterval` armed at startup
 * is what produces the drifting "hourly" check-ins this deployment sees, and it
 * survives neither a restart nor a suspend nor a clock jump. A due time in the
 * database survives all three: a wake missed while the service was down is
 * still due when it comes back, and fires on the next tick instead of
 * evaporating. The cost is one indexed SELECT every `tickSeconds`.
 *
 * **Claim, then dispatch.** An agent turn takes minutes; a tick runs every
 * thirty seconds. The row is advanced out of the due set before the loop starts,
 * so a slow turn cannot be re-fired underneath itself. That makes delivery
 * at-most-once, which is the right side to fail on — a wake that arrives twice
 * is worse than one that arrives never, and the crash window between claim and
 * dispatch costs exactly one wake, logged.
 */

import { runAgentLoop } from "../agent/loop.js";
import { loadSession } from "../agent/session.js";
import type { RoomWatcher, ScheduledWakeOutcome } from "../rooms/watcher.js";
import type { AgentRuntime } from "../runtime.js";
import { runtimeTimeProvider } from "../time/provider.js";
import { fromDbTime, type ScheduleRow, ScheduleStore } from "./store.js";
import { describeBooking, lateLine, recurringLine, type WakeContext } from "./wake-context.js";
import { nextOccurrence, type Recurrence } from "./when.js";

export interface ScheduleRunnerOptions {
  runtime: AgentRuntime;
  /**
   * Resolved lazily: the watcher is constructed after this and may be replaced
   * on reload. Mirrors AutopilotWorker's `getTaskWatcher`.
   */
  getRoomWatcher?: () => RoomWatcher | undefined;
  /** Injectable clock, so the tick is testable without waiting. */
  now?: () => Date;
}

/** Defaults live in config.ts DEFAULT_CONFIG; these are the fallbacks for direct construction. */
const FALLBACK_TICK_SECONDS = 30;
const FALLBACK_MAX_DEFERRALS = 3;
/** How long a wake refused by the room's wake ceiling waits before trying again. */
const DEFER_MINUTES = 5;

export class ScheduleRunner {
  private readonly runtime: AgentRuntime;
  private readonly store: ScheduleStore;
  private readonly getRoomWatcher: (() => RoomWatcher | undefined) | undefined;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** In-flight ids, so a long turn is not counted twice by overlapping ticks. */
  private running = new Set<string>();

  constructor(opts: ScheduleRunnerOptions) {
    this.runtime = opts.runtime;
    this.store = new ScheduleStore(opts.runtime.db);
    this.getRoomWatcher = opts.getRoomWatcher;
    this.now = opts.now ?? (() => runtimeTimeProvider(opts.runtime).now());
  }

  private settings() {
    return this.runtime.getConfig().schedules;
  }

  private timeZone(): string {
    return runtimeTimeProvider(this.runtime).timeZone();
  }

  start(): void {
    this.stop();
    const cfg = this.settings();
    if (cfg?.enabled === false) {
      console.log("[schedules] Disabled by config");
      return;
    }
    const seconds = cfg?.tickSeconds ?? FALLBACK_TICK_SECONDS;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => {
        console.error("[schedules] Tick failed:", (err as Error).message);
      });
    }, seconds * 1000);
    this.timer.unref?.();
    console.log(`[schedules] Watching for due wakes every ${seconds}s`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  restart(): void {
    this.stop();
    this.start();
  }

  /**
   * One pass over the due set. Public so tests can drive it directly rather
   * than through a real timer.
   */
  async tick(): Promise<void> {
    for (const row of this.store.listDue(this.now())) {
      if (this.running.has(row.id)) continue;
      try {
        await this.fire(row);
      } catch (err) {
        console.error(`[schedules] ${row.id} (${row.agent}) failed: ${(err as Error).message}`);
      }
    }
  }

  private recurrenceOf(row: ScheduleRow): Recurrence | null {
    if (row.kind !== "repeat") return null;
    if (row.interval_seconds) return { mode: "interval", seconds: row.interval_seconds, source: row.source };
    if (row.cron) return { mode: "cron", cron: row.cron, source: row.source };
    return null;
  }

  private async fire(row: ScheduleRow): Promise<void> {
    const now = this.now();
    const due = fromDbTime(row.next_run_at);

    // A pause stops autonomous work, and a scheduled wake is exactly that.
    // Recurring occurrences are skipped — the next one comes round anyway — but
    // a one-shot is left due, so a commitment made before the pause is kept
    // the moment it lifts rather than silently dropped.
    if (this.runtime.isAgentsPaused("autonomous")) {
      if (row.kind === "once") return;
      const rec = this.recurrenceOf(row);
      const next = rec
        ? nextOccurrence(rec, now, row.starts_at ? fromDbTime(row.starts_at) : null, this.timeZone())
        : null;
      if (!next) {
        this.store.setStatus(row.id, "expired");
        return;
      }
      console.log(`[schedules] ${row.id} (${row.agent}) skipped: agents are paused`);
      this.store.claim(row.id, { nextRunAt: next, status: this.statusAfter(row, next) });
      return;
    }

    // Claim before dispatch. See the file header.
    const rec = this.recurrenceOf(row);
    const next = rec
      ? nextOccurrence(rec, now, row.starts_at ? fromDbTime(row.starts_at) : null, this.timeZone())
      : null;
    const claimed = this.store.claim(row.id, {
      nextRunAt: next,
      status: row.kind === "once" ? "done" : this.statusAfter(row, next),
    });
    if (!claimed) return;

    this.running.add(row.id);
    try {
      const lateBy = now.getTime() - due.getTime();
      const outcome = await this.dispatch(row, lateBy);
      if (outcome === "at-ceiling") this.handleDeferral(row);
      if (outcome === "gone") {
        this.store.setStatus(row.id, "expired");
        console.warn(
          `[schedules] ${row.id} (${row.agent}) expired: ${row.target} is no longer somewhere this agent can wake`,
        );
      }
      if (outcome === "ran") {
        this.store.markRan(row.id, now);
        this.runtime.events?.emit("schedule.fired", {
          id: row.id,
          agent: row.agent,
          kind: row.kind,
          note: row.note,
          targetKind: row.target_kind,
          target: row.target,
        });
      }
    } finally {
      this.running.delete(row.id);
    }
  }

  /** A recurrence that has run out of occurrences, or passed its end date, is done. */
  private statusAfter(row: ScheduleRow, next: Date | null): "pending" | "expired" {
    if (!next) return "expired";
    if (row.ends_at && next.getTime() > fromDbTime(row.ends_at).getTime()) return "expired";
    return "pending";
  }

  /**
   * The room refused the wake because the agent is at its hourly ceiling. Try
   * again shortly rather than dropping it, but not forever: a room permanently
   * at its limit would otherwise collect a retry every five minutes for ever.
   */
  private handleDeferral(row: ScheduleRow): void {
    const max = this.settings()?.maxDeferrals ?? FALLBACK_MAX_DEFERRALS;
    if (row.deferrals >= max) {
      console.warn(
        `[schedules] ${row.id} (${row.agent}) gave up after ${max} deferrals — ${row.target} is at its wake ceiling`,
      );
      if (row.kind === "once") this.store.setStatus(row.id, "expired");
      return;
    }
    const until = new Date(this.now().getTime() + DEFER_MINUTES * 60_000);
    // A recurrence whose end date has passed is not resurrected by a retry —
    // claim() already expired it, and the deferral is for a wake that still has
    // a reason to exist.
    if (row.ends_at && until.getTime() > fromDbTime(row.ends_at).getTime()) return;
    // Re-open the row: claim() already moved it, and for a one-shot that means
    // 'done'. Deferring has to put it back in the due set to mean anything.
    // Safe for a recurrence too: the following occurrence is recomputed from
    // the anchor when it fires, so the pattern is not shifted by the retry.
    this.store.setStatus(row.id, "pending");
    this.store.defer(row.id, until);
    console.log(`[schedules] ${row.id} (${row.agent}) deferred ${DEFER_MINUTES}m: at wake ceiling`);
  }

  private async dispatch(row: ScheduleRow, lateBy: number): Promise<ScheduledWakeOutcome> {
    const context = {
      scheduleId: row.id,
      note: row.note,
      kind: row.kind,
      source: row.source,
      createdAt: fromDbTime(row.created_at),
      // The run this wake IS, not the count before it. markRan lands after the
      // turn, so the stored value is still one behind here.
      runCount: row.run_count + 1,
      lateBy,
    };

    if (row.target_kind === "room") {
      const watcher = this.getRoomWatcher?.();
      if (!watcher) {
        console.warn(`[schedules] ${row.id} wants room ${row.target} but rooms are not running`);
        return "at-ceiling"; // treat as retryable: rooms may come back
      }
      return await watcher.runScheduledWake(row.agent, row.target, context);
    }

    return await this.runSessionWake(row, context);
  }

  /**
   * A wake booked outside a room. The turn runs in the session it was booked
   * from and its reply persists there; nothing is pushed anywhere. The prompt
   * says so, because an agent that assumes it has been heard will not use the
   * tools that would actually reach someone.
   */
  private async runSessionWake(row: ScheduleRow, ctx: WakeContext): Promise<ScheduledWakeOutcome> {
    const session = loadSession(this.runtime.db, row.target);
    if (!session) return "gone";

    const prompt = [
      `This is a wake you scheduled${describeBooking(ctx, this.now())}.`,
      `Your note to yourself: "${ctx.note}"`,
      ...lateLine(ctx.lateBy),
      ...recurringLine(ctx),
      "",
      "Act on the note.",
      "Nobody is reading this session right now. If something here needs to reach a person, send it — a reply here goes nowhere on its own.",
    ].join("\n");

    console.log(`[schedules] ${ctx.scheduleId} waking ${row.agent} in session ${row.target}`);
    await runAgentLoop(prompt, this.runtime.buildLoopOptions({ session, agentName: row.agent }));
    return "ran";
  }
}
