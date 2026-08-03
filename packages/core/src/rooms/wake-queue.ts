/**
 * When is an agent due to run?
 *
 * Three things start a room turn — a message arrives, a poll tick fires, a
 * scheduled check-in comes due — and each used to own its own timing and its
 * own idea of "already handled". So there was no single place that could answer
 * "is this agent already due, and why", which is the question everything about
 * wake volume turns on.
 *
 * This owns that and nothing else. What to run when an entry comes due belongs
 * to the caller; the queue only decides whether an agent is due and when.
 *
 * **One entry per agent.** Enqueueing an agent that is already waiting merges
 * the new room and trigger into the existing entry instead of adding a second.
 * So the queue's length is bounded by the number of agents and never by how
 * much traffic arrives: ten rooms and a thousand messages produce one entry.
 * An agent watching ten busy rooms used to be scheduled ten times over; now it
 * is scheduled once and told about all ten.
 *
 * The queue bounds how often an agent is *scheduled*. It does not by itself
 * collapse the runs that scheduling produces — a caller handed an entry with
 * ten rooms may still start ten turns. Turning one due entry into one turn is
 * a change to the caller, not to this file.
 */

/** What put an agent in the queue. Not `WakeReason`, which is why the wake policy said yes. */
export type WakeTrigger = "message" | "poll" | "check-in";

export interface WakeRequest {
  agent: string;
  roomRef: string;
  trigger: WakeTrigger;
}

/** An agent that is due, and everything that made it due. */
export interface WakeEntry {
  agent: string;
  /** Room ref → the triggers that fired for it while this entry waited. */
  targets: Map<string, Set<WakeTrigger>>;
}

export interface WakeQueueOptions {
  /** How long a trigger waits before it is due. Lets a burst collapse into one turn. */
  delayMs: (trigger: WakeTrigger) => number;
  /**
   * Shortest gap between one agent's wakes, in ms. Triggers arriving inside it
   * accumulate on the waiting entry rather than starting a turn, so an agent in
   * a busy deployment runs on a predictable cadence instead of on demand.
   * 0 disables it, which is the default.
   */
  minIntervalMs?: () => number;
  /** Called once per entry, when it comes due. Must not throw. */
  onDue: (entry: WakeEntry) => void;
  /** Injectable clock, so the cooldown is testable without waiting. */
  now?: () => number;
}

/**
 * Entry identity: the agent.
 *
 * This is the whole design in one function. Keying by agent — rather than by
 * agent-and-room, which is what every wake path used to do independently — is
 * what makes an agent's attention a thing the system can reason about at all.
 */
export function queueKey(request: Pick<WakeRequest, "agent">): string {
  return request.agent;
}

interface Waiting {
  entry: WakeEntry;
  timer: ReturnType<typeof setTimeout>;
  /** When the entry is currently scheduled to fire, so a re-arm can compare. */
  dueAt: number;
}

export class WakeQueue {
  private waiting = new Map<string, Waiting>();
  private lastDueAt = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly opts: WakeQueueOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Mark an agent due for a room.
   *
   * Merging rules, in the order they matter:
   *
   * - the room and trigger join the agent's existing entry, if it has one
   * - the entry fires at the earliest time any of its triggers asks for, so a
   *   poll tick that is already due is not held back by a message still
   *   inside its batching window
   * - never sooner than `minIntervalMs` after the agent last ran
   *
   * Deliberately *not* a debounce reset: an agent in a room that never goes
   * quiet would have its turn postponed indefinitely, which is the starvation
   * the per-room debounce could produce. Once an agent is due at a time, more
   * traffic can only make it sooner.
   */
  enqueue(request: WakeRequest): void {
    const key = queueKey(request);
    const now = this.now();
    const cooldownEnds = (this.lastDueAt.get(key) ?? Number.NEGATIVE_INFINITY) + this.minInterval();
    const wanted = Math.max(now + this.opts.delayMs(request.trigger), cooldownEnds);

    const existing = this.waiting.get(key);
    if (existing) {
      const triggers = existing.entry.targets.get(request.roomRef) ?? new Set<WakeTrigger>();
      triggers.add(request.trigger);
      existing.entry.targets.set(request.roomRef, triggers);
      if (wanted < existing.dueAt) this.arm(key, existing.entry, wanted, now);
      return;
    }

    const entry: WakeEntry = {
      agent: request.agent,
      targets: new Map([[request.roomRef, new Set([request.trigger])]]),
    };
    this.arm(key, entry, wanted, now);
  }

  private arm(key: string, entry: WakeEntry, dueAt: number, now: number): void {
    const prior = this.waiting.get(key);
    if (prior) clearTimeout(prior.timer);
    const timer = setTimeout(
      () => {
        this.waiting.delete(key);
        this.lastDueAt.set(key, this.now());
        this.opts.onDue(entry);
      },
      Math.max(0, dueAt - now),
    );
    timer.unref?.();
    this.waiting.set(key, { entry, timer, dueAt });
  }

  private minInterval(): number {
    return Math.max(0, this.opts.minIntervalMs?.() ?? 0);
  }

  /** Whether this agent is already waiting. */
  has(agent: string): boolean {
    return this.waiting.has(agent);
  }

  /** How many agents are waiting. Bounded by agent count, never by traffic. */
  get size(): number {
    return this.waiting.size;
  }

  /** Everything currently waiting, for diagnostics. */
  list(): WakeEntry[] {
    return [...this.waiting.values()].map((w) => w.entry);
  }

  clear(): void {
    for (const { timer } of this.waiting.values()) clearTimeout(timer);
    this.waiting.clear();
    this.lastDueAt.clear();
  }
}
