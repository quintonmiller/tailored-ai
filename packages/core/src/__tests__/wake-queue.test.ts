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
import { queueKey, type WakeEntry, WakeQueue, type WakeRequest } from "../rooms/wake-queue.js";

const req = (over: Partial<WakeRequest> = {}): WakeRequest => ({
  agent: "coder",
  roomRef: "local:eng",
  trigger: "message",
  ...over,
});

const make = (onDue: (e: WakeEntry) => void, delay = 3000) => new WakeQueue({ delayMs: () => delay, onDue });

/** Rooms named by an entry, sorted so assertions do not depend on insertion order. */
const roomsOf = (e: WakeEntry) => [...e.targets.keys()].sort();

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("coalescing", () => {
  it("runs once for a burst, and only after the delay", async () => {
    const due: WakeEntry[] = [];
    const q = make((e) => due.push(e));

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

  /**
   * The change this phase exists for: an agent is one entry however many of
   * its rooms are busy. Different agents stay separate.
   */
  it("merges every room and trigger for one agent into a single entry", () => {
    const q = make(() => {});

    q.enqueue(req());
    q.enqueue(req({ roomRef: "local:ops" }));
    q.enqueue(req({ trigger: "poll" }));
    q.enqueue(req({ agent: "planner" }));

    expect(q.size).toBe(2);
    const coder = q.list().find((e) => e.agent === "coder");
    expect(roomsOf(coder as WakeEntry)).toEqual(["local:eng", "local:ops"]);
    expect([...(coder as WakeEntry).targets.get("local:eng")!].sort()).toEqual(["message", "poll"]);
  });

  it("tells the caller every room that made the agent due", async () => {
    const due: WakeEntry[] = [];
    const q = make((e) => due.push(e));

    for (const r of ["local:a", "local:b", "local:c", "local:d"]) q.enqueue(req({ roomRef: r }));
    await vi.advanceTimersByTimeAsync(3100);

    expect(due).toHaveLength(1);
    expect(roomsOf(due[0])).toEqual(["local:a", "local:b", "local:c", "local:d"]);
  });

  /**
   * Once an agent is due at a time, more traffic can only make it sooner.
   * Resetting the timer on every message would let a room that never goes
   * quiet postpone a turn indefinitely — the starvation the old per-room
   * debounce could produce.
   */
  it("a repeat enqueue does not postpone a turn already scheduled", async () => {
    const due: WakeEntry[] = [];
    const q = make((e) => due.push(e));

    q.enqueue(req());
    await vi.advanceTimersByTimeAsync(2000);
    q.enqueue(req());
    await vi.advanceTimersByTimeAsync(1100);

    expect(due).toHaveLength(1);
  });

  /** A trigger that is due sooner pulls the whole entry forward. */
  it("an immediate trigger pulls a waiting entry forward", async () => {
    const due: WakeEntry[] = [];
    const q = new WakeQueue({
      delayMs: (t) => (t === "message" ? 3000 : 0),
      onDue: (e) => due.push(e),
    });

    q.enqueue(req({ trigger: "message" }));
    q.enqueue(req({ roomRef: "local:ops", trigger: "poll" }));
    await vi.advanceTimersByTimeAsync(50);

    expect(due).toHaveLength(1);
    expect(roomsOf(due[0])).toEqual(["local:eng", "local:ops"]);
  });
});

describe("delay by trigger", () => {
  /** A poll tick and a check-in are already the product of their own interval. */
  it("lets each trigger set its own wait", async () => {
    const due: WakeEntry[] = [];
    const q = new WakeQueue({
      delayMs: (t) => (t === "message" ? 3000 : 0),
      onDue: (e) => due.push(e),
    });

    q.enqueue(req({ agent: "planner", trigger: "poll" }));
    q.enqueue(req({ agent: "coder", trigger: "message" }));
    await vi.advanceTimersByTimeAsync(10);

    expect(due.map((d) => d.agent)).toEqual(["planner"]);

    await vi.advanceTimersByTimeAsync(3100);
    expect(due.map((d) => d.agent)).toEqual(["planner", "coder"]);
  });
});

describe("minimum interval between an agent's wakes", () => {
  /** The throttle: traffic accumulates instead of starting another turn. */
  it("holds a second wake until the interval has passed", async () => {
    let clock = 0;
    const due: WakeEntry[] = [];
    const q = new WakeQueue({
      delayMs: () => 0,
      minIntervalMs: () => 60_000,
      onDue: (e) => due.push(e),
      now: () => clock,
    });

    q.enqueue(req());
    await vi.advanceTimersByTimeAsync(10);
    expect(due).toHaveLength(1);

    clock = 10_000;
    q.enqueue(req({ roomRef: "local:ops" }));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(due, "still inside the interval").toHaveLength(1);

    await vi.advanceTimersByTimeAsync(40_000);
    expect(due).toHaveLength(2);
    expect(roomsOf(due[1])).toEqual(["local:ops"]);
  });

  /** Everything that arrived during the wait is on the entry when it fires. */
  it("accumulates rooms across the whole cooldown", async () => {
    let clock = 0;
    const due: WakeEntry[] = [];
    const q = new WakeQueue({
      delayMs: () => 0,
      minIntervalMs: () => 60_000,
      onDue: (e) => due.push(e),
      now: () => clock,
    });

    q.enqueue(req());
    await vi.advanceTimersByTimeAsync(10);

    clock = 5_000;
    q.enqueue(req({ roomRef: "local:a" }));
    clock = 30_000;
    q.enqueue(req({ roomRef: "local:b" }));
    await vi.advanceTimersByTimeAsync(70_000);

    expect(due).toHaveLength(2);
    expect(roomsOf(due[1])).toEqual(["local:a", "local:b"]);
  });

  it("is off by default", async () => {
    const due: WakeEntry[] = [];
    const q = make((e) => due.push(e), 0);

    q.enqueue(req());
    await vi.advanceTimersByTimeAsync(10);
    q.enqueue(req());
    await vi.advanceTimersByTimeAsync(10);

    expect(due).toHaveLength(2);
  });
});

describe("lifecycle", () => {
  it("forgets an entry once it comes due, so the next one waits again", async () => {
    const due: WakeEntry[] = [];
    const q = make((e) => due.push(e));

    q.enqueue(req());
    await vi.advanceTimersByTimeAsync(3100);
    expect(q.size).toBe(0);

    q.enqueue(req());
    expect(q.size).toBe(1);
    await vi.advanceTimersByTimeAsync(3100);

    expect(due).toHaveLength(2);
  });

  it("clear() drops everything without firing it", async () => {
    const due: WakeEntry[] = [];
    const q = make((e) => due.push(e));

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

    expect(q.has("coder")).toBe(true);
    expect(q.has("reviewer")).toBe(false);
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
  it("is the agent, and nothing else", () => {
    expect(queueKey(req())).toBe(queueKey(req({ roomRef: "local:ops", trigger: "poll" })));
    expect(queueKey(req())).not.toBe(queueKey(req({ agent: "planner" })));
  });
});
