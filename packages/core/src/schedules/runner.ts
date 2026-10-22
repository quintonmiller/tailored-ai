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
 *
 * **A session wake goes through `runtime.wakeAgent`.** It stops for what every
 * turn nobody asked for stops for, counts toward the agent's hourly wake
 * ceiling, and its tools see it as `{ kind: "schedule", ref: <schedule id> }`.
 * A one-shot the waker turns away waits until it can run rather than being
 * lost. A room wake goes through the room watcher, which applies the room's own.
 */

import type { WakeOutcome } from "../agent/wake.js";
import type { RoomWatcher } from "../rooms/watcher.js";
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
/** How long a wake refused by a wake ceiling, or held while its agent is paused, waits before trying again. */
const DEFER_MINUTES = 5;

/** What a held one-shot waits for: its agent's own pause to lift, or its hourly wake ceiling to have room. */
type HeldFor = "paused" | "at-ceiling";

export class ScheduleRunner {
  private readonly runtime: AgentRuntime;
  private readonly store: ScheduleStore;
  private readonly getRoomWatcher: (() => RoomWatcher | undefined) | undefined;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** In-flight ids, so a long turn is not counted twice by overlapping ticks. */
  private running = new Set<string>();
  /**
   * One-shots booked in a session that are waiting, by id, with when to look
   * again and what for: their agent switched off or paused on its own, or its
   * hourly wake ceiling. In memory: a restart looks at once.
   */
  private readonly held = new Map<string, { at: number; for: HeldFor }>();

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
    const now = this.now();
    for (const row of this.store.listDue(now)) {
      if (this.running.has(row.id)) continue;
      if ((this.held.get(row.id)?.at ?? 0) > now.getTime()) continue;
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
      if (outcome === "ran" || outcome === "gone") this.held.delete(row.id);
      if (outcome === "at-ceiling") this.handleDeferral(row);
      if (outcome === "paused") this.holdWhilePaused(row);
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
   * The room or the waker refused the wake: the agent is at its hourly
   * ceiling, or a turn is still running where it would land. Try again
   * shortly rather than dropping it, but not forever: an agent permanently at
   * its limit would otherwise collect a retry every five minutes for ever.
   * A one-shot booked in a session waits instead (`holdAtCeiling`).
   */
  private handleDeferral(row: ScheduleRow): void {
    if (row.target_kind === "session" && row.kind === "once") {
      this.holdAtCeiling(row);
      return;
    }
    const max = this.settings()?.maxDeferrals ?? FALLBACK_MAX_DEFERRALS;
    if (row.deferrals >= max) {
      // A session's ceiling is its agent's own; a room's is the room's.
      const full = row.target_kind === "session" ? row.agent : row.target;
      console.warn(
        `[schedules] ${row.id} (${row.agent}) gave up after ${max} deferrals — ${full} is at its wake ceiling`,
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

  /**
   * The agent is switched off or paused on its own on the Agents page, which
   * is a pause for that agent, so it is treated like one: a one-shot waits
   * until it lifts, looked at again every few minutes and with its due time
   * kept, so the agent hears how late it is; a recurring occurrence is skipped,
   * since the next one comes round anyway.
   */
  private holdWhilePaused(row: ScheduleRow): void {
    if (row.kind !== "once") {
      console.log(`[schedules] ${row.id} (${row.agent}) skipped: ${row.agent} is paused`);
      return;
    }
    this.hold(row, DEFER_MINUTES * 60_000, "paused", `held until ${row.agent} is no longer paused`);
  }

  /**
   * A one-shot booked in a session that the waker turned away: its agent is
   * at its hourly wake ceiling, or a woken turn is still running in that
   * session. Both pass within the hour, and a one-shot is a commitment that
   * a few retries would give up on, so it waits like a paused one: until the
   * hour has room, when the waker can say, or a few minutes when it can't,
   * with its due time kept so the agent hears how late it is. A recurring
   * occurrence keeps the retries, since the next one comes round anyway.
   */
  private holdAtCeiling(row: ScheduleRow): void {
    const refusal = this.runtime.wakeRefusal(row.agent, { sessionId: row.target });
    // The waker keeps real time and this runner its time provider's, so what carries over is how long, not when.
    const wait = refusal?.until !== undefined ? Math.max(0, refusal.until - Date.now()) : DEFER_MINUTES * 60_000;
    const why = refusal?.why ?? `${row.agent}'s wake was turned away`;
    this.hold(row, wait, "at-ceiling", `held for ${Math.ceil(wait / 60_000)}m: ${why}`);
  }

  /** Keeps a one-shot due, as late as it is, and looks at it again after `wait` ms. Said once for each reason. */
  private hold(row: ScheduleRow, wait: number, reason: HeldFor, line: string): void {
    if (this.held.get(row.id)?.for !== reason) console.log(`[schedules] ${row.id} (${row.agent}) ${line}`);
    this.held.set(row.id, { at: this.now().getTime() + wait, for: reason });
    // claim() marked it done and left its due time as it was: back in the due set, still as late as it is.
    this.store.setStatus(row.id, "pending");
  }

  private async dispatch(row: ScheduleRow, lateBy: number): Promise<WakeOutcome> {
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
   * from, by its id, and its reply persists there; nothing is pushed anywhere.
   * The prompt says so, because an agent that assumes it has been heard will
   * not use the tools that would actually reach someone. A session that is no
   * longer there is `gone`.
   */
  private async runSessionWake(row: ScheduleRow, ctx: WakeContext): Promise<WakeOutcome> {
    const prompt = [
      `This is a wake you scheduled${describeBooking(ctx, this.now())}.`,
      `Your note to yourself: "${ctx.note}"`,
      ...lateLine(ctx.lateBy),
      ...recurringLine(ctx),
      "",
      "Act on the note.",
      "Nobody is reading this session right now. If something here needs to reach a person, send it — a reply here goes nowhere on its own.",
    ].join("\n");

    return this.runtime.wakeAgent(row.agent, {
      prompt,
      sessionId: row.target,
      wake: { kind: "schedule", ref: row.id },
    });
  }
}
