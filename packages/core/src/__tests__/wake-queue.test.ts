/**
 * The wake queue: when is an agent due to run.
 *
 * Three paths start a room turn — a message, a poll tick, a check-in — and
 * each used to own its own timing and its own idea of "already handled". These
 * pin the behaviour they share now that one thing decides it, and in
 * particular the property the whole design rests on: enqueueing an agent that
 * is already waiting merges into the existing entry rather than adding a
 * second, so the queue's length is bounded by distinct keys and never by how
 * much traffic arrives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queueKey, WakeQueue, type WakeRequest } from "../rooms/wake-queue.js";

const req = (over: Partial<WakeRequest> = {}): WakeRequest => ({
  agent: "coder",
  roomRef: "local:eng",
  trigger: "message",
  ...over,
});

const make = (onDue: (r: WakeRequest) => void, delay = 3000) => new WakeQueue({ delayMs: () => delay, onDue });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("coalescing", () => {
  it("runs once for a burst, and only after the delay", async () => {
    const due: WakeRequest[] = [];
    const q = make((r) => due.push(r));

    q.enqueue(req());
    q.enqueue(req());
    q.enqueue(req());
    expect(due).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(3100);

    expect(due).toHaveLength(1);
  });

  /** The property the design rests on: length tracks agents, not messages. */
  it("holds one entry per key no matter how much arrives", () => {
    const q = make(() => {});

    for (let i = 0; i < 500; i++) q.enqueue(req());

    expect(q.size).toBe(1);
  });

  it("keeps separate entries per agent, room and trigger", () => {
    const q = make(() => {});

    q.enqueue(req());
    q.enqueue(req({ agent: "planner" }));
    q.enqueue(req({ roomRef: "local:ops" }));
    q.enqueue(req({ trigger: "poll" }));

    expect(q.size).toBe(4);
  });

  /**
   * A later message restarts the wait rather than being dropped, so the turn
   * that eventually runs has seen everything.
   */
  it("a repeat enqueue extends the wait", async () => {
    const due: WakeRequest[] = [];
    const q = make((r) => due.push(r));

    q.enqueue(req());
    await vi.advanceTimersByTimeAsync(2000);
    q.enqueue(req());
    await vi.advanceTimersByTimeAsync(2000);

    expect(due).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1100);
    expect(due).toHaveLength(1);
  });
});

describe("delay by trigger", () => {
  /** A poll tick and a check-in are already the product of their own interval. */
  it("lets each trigger set its own wait", async () => {
    const due: WakeRequest[] = [];
    const q = new WakeQueue({
      delayMs: (t) => (t === "message" ? 3000 : 0),
      onDue: (r) => due.push(r),
    });

    q.enqueue(req({ trigger: "poll" }));
    q.enqueue(req({ trigger: "message" }));
    await vi.advanceTimersByTimeAsync(10);

    expect(due.map((d) => d.trigger)).toEqual(["poll"]);

    await vi.advanceTimersByTimeAsync(3100);
    expect(due.map((d) => d.trigger)).toEqual(["poll", "message"]);
  });
});

describe("lifecycle", () => {
  it("forgets an entry once it comes due, so the next one waits again", async () => {
    const due: WakeRequest[] = [];
    const q = make((r) => due.push(r));

    q.enqueue(req());
    await vi.advanceTimersByTimeAsync(3100);
    expect(q.size).toBe(0);

    q.enqueue(req());
    expect(q.size).toBe(1);
    await vi.advanceTimersByTimeAsync(3100);

    expect(due).toHaveLength(2);
  });

  it("clear() drops everything without firing it", async () => {
    const due: WakeRequest[] = [];
    const q = make((r) => due.push(r));

    q.enqueue(req());
    q.enqueue(req({ agent: "planner" }));
    q.clear();
    await vi.advanceTimersByTimeAsync(5000);

    expect(q.size).toBe(0);
    expect(due).toHaveLength(0);
  });

  it("reports what is waiting", () => {
    const q = make(() => {});

    q.enqueue(req());
    q.enqueue(req({ agent: "planner" }));

    expect(q.has(req())).toBe(true);
    expect(q.has(req({ agent: "reviewer" }))).toBe(false);
    expect(
      q
        .list()
        .map((r) => r.agent)
        .sort(),
    ).toEqual(["coder", "planner"]);
  });
});

describe("queueKey", () => {
  /**
   * The one place entry identity is defined. Making a wake per-agent rather
   * than per-agent-per-room is a change here and to how entries merge, not a
   * change to any caller — which is the reason this is a named function.
   */
  it("separates agent, room and trigger", () => {
    expect(queueKey(req())).toBe(queueKey(req()));
    expect(queueKey(req())).not.toBe(queueKey(req({ agent: "planner" })));
    expect(queueKey(req())).not.toBe(queueKey(req({ roomRef: "local:ops" })));
    expect(queueKey(req())).not.toBe(queueKey(req({ trigger: "poll" })));
  });
});
