/**
 * When is an agent due to run?
 *
 * Three things start a room turn — a message arrives, a poll tick fires, a
 * scheduled check-in comes due — and each used to own its own timing and its
 * own idea of "already handled". The message path debounced on
 * `${agent} ${roomRef}`; the other two had no coalescing at all and relied on
 * the in-flight guard further down to sort out overlaps. So there was no single
 * place that could answer "is this agent already due, and why", which is the
 * question everything about wake volume turns on.
 *
 * This owns that and nothing else. What to run when an entry comes due belongs
 * to the caller; the queue only decides whether an agent is due and when.
 *
 * The identity of an entry is `queueKey`, deliberately one function. Today it
 * is per (agent, room, trigger), which is what the code did before this
 * existed. Making it per-agent — so an agent with ten busy rooms is due once
 * rather than ten times — is a change to that function and to how entries
 * merge, not a change to any caller. That is the point of the seam.
 */

/** What put an agent in the queue. Not the same as `WakeReason`, which is why the wake policy said yes. */
export type WakeTrigger = "message" | "poll" | "check-in";

export interface WakeRequest {
  agent: string;
  roomRef: string;
  trigger: WakeTrigger;
}

export interface WakeQueueOptions {
  /** How long an entry waits before it is due. Lets a burst collapse into one turn. */
  delayMs: (trigger: WakeTrigger) => number;
  /** Called once per entry, when it comes due. Must not throw. */
  onDue: (request: WakeRequest) => void;
}

/**
 * Entry identity.
 *
 * Enqueueing something already queued merges into the existing entry rather
 * than adding a second — which is what makes the queue's length bounded by the
 * number of distinct keys rather than by how much traffic arrives.
 */
export function queueKey(request: WakeRequest): string {
  return `${request.trigger}:${request.agent} ${request.roomRef}`;
}

export class WakeQueue {
  private entries = new Map<string, { request: WakeRequest; timer: ReturnType<typeof setTimeout> }>();

  constructor(private readonly opts: WakeQueueOptions) {}

  /**
   * Mark an agent due. Enqueueing one that is already waiting restarts its
   * delay rather than queueing a second turn — five messages in two seconds
   * should produce one run that sees all five.
   */
  enqueue(request: WakeRequest): void {
    const key = queueKey(request);
    const existing = this.entries.get(key);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      this.entries.delete(key);
      this.opts.onDue(request);
    }, this.opts.delayMs(request.trigger));
    timer.unref?.();
    this.entries.set(key, { request, timer });
  }

  /** Whether this agent is already waiting for this room and trigger. */
  has(request: WakeRequest): boolean {
    return this.entries.has(queueKey(request));
  }

  /** How many agents are waiting. Bounded by distinct keys, never by traffic. */
  get size(): number {
    return this.entries.size;
  }

  /** Everything currently waiting, for diagnostics. */
  list(): WakeRequest[] {
    return [...this.entries.values()].map((e) => e.request);
  }

  clear(): void {
    for (const { timer } of this.entries.values()) clearTimeout(timer);
    this.entries.clear();
  }
}
