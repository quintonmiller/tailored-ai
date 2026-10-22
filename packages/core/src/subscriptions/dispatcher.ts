/**
 * Turns runtime events into agent turns, on each subscription's schedule.
 *
 * The dispatcher owns timing and nothing else. It listens for the events
 * subscriptions name, matches them with the same `when` matcher `hooks.on`
 * uses, holds them according to the delivery mode, and hands what is due to a
 * {@link SubscriptionDelivery}, which turns it into a room turn or a session
 * turn. Pending events live in SQLite, so a restart loses none of them.
 *
 * Deliberately not the rooms' wake queue. Like a scheduled wake, an event
 * wake carries its own payload — the events are the reason for the turn —
 * and the delivery mode already says when it should happen, so collapsing it
 * into a message wake would either drop the events or second-guess the mode.
 * Room delivery still goes through the room's turn order, in-flight guard and
 * hourly ceiling, by way of the watcher.
 *
 * `runtime.reload()` clears the event bus, so the host calls `restart()`
 * after a reload, exactly as it does for the schedule runner.
 */
import type Database from "better-sqlite3";
import { type ContextSlot, registerContextSlot, unregisterContextSlot } from "../agent/context-slots.js";
import { matchesWhen } from "../agent/event-hooks.js";
import { type EventBus, isWaterfallEvent, type RuntimeEvent, type Subscription } from "../events.js";
import { ROOM_WATCHER_DEFAULTS } from "../rooms/watcher.js";
import { formatLocal, nextOccurrence, parseEvery, type Recurrence } from "../schedules/when.js";
import { describeEvent } from "./describe.js";
import { parseWindow, subscriptionKey } from "./keys.js";
import { SubscriptionStore } from "./store.js";
import type {
  DeliveredEvent,
  DeliveryMode,
  EventSubscriptionConfig,
  SubscriptionDelivery,
  SubscriptionTarget,
} from "./types.js";

/** How long a refused delivery waits before it is tried again. */
const RETRY_MS = 60_000;
/** An hour of retries: long enough for any wake ceiling to reset. */
const MAX_RETRIES = 60;
/** At most this many recorded events land in one turn; the rest wait for the next. */
const RECORD_LIMIT = 20;
const INBOX_SLOT_ID = "subscriptions.inbox";

export interface SubscriptionDispatcherOptions {
  events: EventBus;
  /** Read on `start()`, so a reload followed by `restart()` picks up changes. */
  getConfig: () => { subscriptions?: EventSubscriptionConfig[]; rooms?: { batchSeconds?: number } };
  db: Database.Database;
  delivery: SubscriptionDelivery;
  /** True while autonomous runs are paused. A paused delivery is held and retried. */
  isPaused?: () => boolean;
  now?: () => Date;
  timeZone?: () => string | undefined;
}

interface ActiveSubscription {
  config: EventSubscriptionConfig;
  key: string;
  deliver: DeliveryMode;
  windowMs?: number;
  every?: Recurrence;
  target: SubscriptionTarget;
}

export class SubscriptionDispatcher {
  readonly store: SubscriptionStore;
  private subs: ActiveSubscription[] = [];
  private handles: Subscription[] = [];
  private readonly timers = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();
  private readonly retries = new Map<string, number>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly now: () => Date;
  /**
   * Between `start()` and `stop()`. A delivery still in flight when the
   * dispatcher stops must not arm a retry afterwards and start a turn after
   * shutdown, so nothing is scheduled while this is false.
   */
  private active = false;

  constructor(private readonly opts: SubscriptionDispatcherOptions) {
    this.store = new SubscriptionStore(opts.db);
    this.now = opts.now ?? (() => new Date());
  }

  start(): void {
    this.active = true;
    this.subs = this.activeSubscriptions();
    const byEvent = new Map<string, ActiveSubscription[]>();
    for (const sub of this.subs) byEvent.set(sub.config.on, [...(byEvent.get(sub.config.on) ?? []), sub]);
    for (const [event, subs] of byEvent) {
      this.handles.push(
        this.opts.events.on(event as RuntimeEvent, (payload: unknown) => {
          for (const sub of subs) this.onEvent(sub, event, payload);
        }),
      );
    }
    this.resume();
    if (this.subs.some((s) => s.deliver === "record")) registerContextSlot(this.inboxSlot());
  }

  stop(): void {
    this.active = false;
    for (const h of this.handles.splice(0)) h.dispose();
    for (const { timer } of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    unregisterContextSlot(INBOX_SLOT_ID);
  }

  /** After a config reload, which also clears the event bus this listens on. */
  restart(): void {
    this.stop();
    this.start();
  }

  /** Deliver whatever is waiting for a subscription now. Exposed for tests and for an operator's "send it now". */
  async flush(subKey: string): Promise<void> {
    const sub = this.subs.find((s) => s.key === subKey);
    if (!sub) return;
    const pending = this.timers.get(subKey);
    if (pending) {
      clearTimeout(pending.timer);
      this.timers.delete(subKey);
    }
    await this.fire(sub);
  }

  private activeSubscriptions(): ActiveSubscription[] {
    const out: ActiveSubscription[] = [];
    for (const config of this.opts.getConfig().subscriptions ?? []) {
      // validateConfig names every one of these; the dispatcher just declines
      // to run a subscription it cannot honour rather than guessing.
      if (!config?.agent || !config.on || isWaterfallEvent(config.on)) continue;
      const deliver = config.deliver ?? "queue";
      const sub: ActiveSubscription = {
        config,
        key: subscriptionKey(config),
        deliver,
        target: config.target ?? "session",
      };
      if (deliver === "batch") {
        sub.windowMs = config.window ? parseWindow(config.window) : undefined;
        if (!sub.windowMs) continue;
      }
      if (deliver === "digest") {
        try {
          sub.every = config.every ? parseEvery(config.every) : undefined;
        } catch {
          sub.every = undefined;
        }
        if (!sub.every) continue;
      }
      out.push(sub);
    }
    return out;
  }

  /** Re-arm timers for whatever was waiting when the process last stopped. */
  private resume(): void {
    const live = new Set(this.subs.map((s) => s.key));
    for (const key of this.store.allKeys()) {
      if (!live.has(key)) {
        const dropped = this.store.discard(key);
        console.warn(
          `[subscriptions] dropped ${dropped} pending event(s) for a subscription no longer in config: ${key}`,
        );
      }
    }
    const now = this.now().getTime();
    for (const { subKey, oldestAt } of this.store.pendingKeys()) {
      const sub = this.subs.find((s) => s.key === subKey);
      if (!sub) continue;
      if (sub.deliver === "batch") this.armIfEarlier(sub, Date.parse(oldestAt) + (sub.windowMs ?? 0));
      else if (sub.deliver !== "digest") this.armIfEarlier(sub, now + this.queueDelayMs());
    }
    for (const sub of this.subs) if (sub.deliver === "digest") this.armDigest(sub);
  }

  private onEvent(sub: ActiveSubscription, event: string, payload: unknown): void {
    const fields = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
    if (!matchesWhen(fields, sub.config.when)) return;
    if (!sub.config.includeOwn && madeBy(fields, sub.config.agent)) return;

    const delivered: DeliveredEvent = { event, summary: describeEvent(event, payload), at: this.now().toISOString() };
    const now = this.now().getTime();
    switch (sub.deliver) {
      case "immediate":
        void this.deliver(sub, [delivered]);
        return;
      case "queue":
        this.store.add(sub.key, sub.config.agent, sub.deliver, delivered);
        this.armIfEarlier(sub, now + this.queueDelayMs());
        return;
      case "batch":
        this.store.add(sub.key, sub.config.agent, sub.deliver, delivered);
        // The window runs from the first event and is not pushed back by later
        // ones, so a steady trickle cannot postpone delivery for ever.
        this.armIfEarlier(sub, now + (sub.windowMs ?? 0));
        return;
      case "digest":
      case "record":
        this.store.add(sub.key, sub.config.agent, sub.deliver, delivered);
        return;
    }
  }

  private async fire(sub: ActiveSubscription): Promise<void> {
    const events = this.store.take(sub.key);
    if (events.length) await this.deliver(sub, events);
    if (sub.deliver === "digest" && !this.timers.has(sub.key)) this.armDigest(sub);
  }

  /**
   * Hand events to the delivery, one turn at a time per agent and target. A
   * refusal puts them back and tries again shortly; a target that no longer
   * exists drops them, loudly.
   */
  private deliver(sub: ActiveSubscription, events: DeliveredEvent[]): Promise<void> {
    const chainKey = `${sub.config.agent}|${targetKey(sub.target)}`;
    const run = async () => {
      const ctx = {
        events,
        deliver: sub.deliver,
        ...(sub.config.instructions ? { instructions: sub.config.instructions } : {}),
        wake: { kind: "subscription", ref: sub.key },
      };
      let outcome: "ran" | "at-ceiling" | "gone";
      try {
        if (this.opts.isPaused?.()) outcome = "at-ceiling";
        else if (sub.target === "session") outcome = await this.opts.delivery.toSession(sub.config.agent, ctx);
        else outcome = await this.opts.delivery.toRoom(sub.config.agent, sub.target.room, ctx);
      } catch (err) {
        console.warn(`[subscriptions] delivering to ${sub.config.agent} failed: ${(err as Error).message}`);
        outcome = "at-ceiling";
      }

      if (outcome === "ran") {
        this.retries.delete(sub.key);
        return;
      }
      if (outcome === "gone") {
        console.warn(
          `[subscriptions] ${sub.config.agent} has nowhere to receive ${events.length} event(s) at ${targetKey(sub.target)}; dropped.`,
        );
        return;
      }
      const attempt = (this.retries.get(sub.key) ?? 0) + 1;
      if (attempt > MAX_RETRIES) {
        this.retries.delete(sub.key);
        console.warn(
          `[subscriptions] gave up delivering ${events.length} event(s) to ${sub.config.agent} after ${MAX_RETRIES} attempts.`,
        );
        return;
      }
      this.retries.set(sub.key, attempt);
      this.store.restore(sub.key, sub.config.agent, sub.deliver, events);
      this.armIfEarlier(sub, this.now().getTime() + RETRY_MS);
    };
    const next = (this.chains.get(chainKey) ?? Promise.resolve()).then(run, run);
    this.chains.set(
      chainKey,
      next.catch(() => undefined),
    );
    return next;
  }

  private armDigest(sub: ActiveSubscription): void {
    if (!sub.every) return;
    const next = nextOccurrence(sub.every, this.now(), null, this.opts.timeZone?.() ?? undefined);
    if (next) this.arm(sub, next.getTime());
  }

  private armIfEarlier(sub: ActiveSubscription, at: number): void {
    const current = this.timers.get(sub.key);
    if (current && current.at <= at) return;
    this.arm(sub, at);
  }

  private arm(sub: ActiveSubscription, at: number): void {
    if (!this.active) return;
    const current = this.timers.get(sub.key);
    if (current) clearTimeout(current.timer);
    const timer = setTimeout(
      () => {
        this.timers.delete(sub.key);
        void this.fire(sub);
      },
      Math.max(0, at - this.now().getTime()),
    );
    timer.unref?.();
    this.timers.set(sub.key, { at, timer });
  }

  private queueDelayMs(): number {
    return (this.opts.getConfig().rooms?.batchSeconds ?? ROOM_WATCHER_DEFAULTS.batchSeconds) * 1000;
  }

  private inboxSlot(): ContextSlot {
    return {
      id: INBOX_SLOT_ID,
      refresh: "turn",
      agents: ["*"],
      title: "Since your last turn",
      budgetTokens: 400,
      render: (ctx) => {
        if (!ctx.agent) return null;
        const events = this.store.takeRecorded(ctx.agent, RECORD_LIMIT);
        if (events.length === 0) return null;
        const more = this.store.countRecorded(ctx.agent);
        return [
          "Things you subscribe to that happened without waking you:",
          ...events.map((e) => `- ${formatLocal(new Date(e.at), this.opts.timeZone?.())}: ${e.summary}`),
          ...(more ? [`(${more} more waiting for your next turn.)`] : []),
        ].join("\n");
      },
    };
  }
}

/**
 * Did this agent make the change itself? Read from whichever field the event
 * uses to name one, including a plugin's write made for the agent.
 */
function madeBy(payload: Record<string, unknown>, agent: string): boolean {
  const actor = payload.actor as { kind?: unknown; name?: unknown } | undefined;
  if (actor && actor.kind === "agent" && actor.name === agent) return true;
  const source = payload.source as { onBehalfOf?: unknown } | undefined;
  if (source && source.onBehalfOf === agent) return true;
  return payload.agent === agent || payload.agentName === agent;
}

function targetKey(target: SubscriptionTarget): string {
  return target === "session" ? "its own session" : `room ${target.room}`;
}
