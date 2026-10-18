/**
 * The subscription dispatcher: timing, and nothing else.
 *
 * Delivery is faked so these tests see exactly what reaches an agent and when.
 * The properties that matter most are the ones a user would only notice by
 * their absence: a burst collapses into one turn, a batch window is not pushed
 * back by a steady trickle, a refused delivery is retried without being
 * duplicated, and nothing waiting is lost across a restart.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listContextSlots } from "../agent/context-slots.js";
import { TypedEventBus } from "../events.js";
import type { StateChange } from "../state/types.js";
import { SubscriptionDispatcher } from "../subscriptions/dispatcher.js";
import { subscriptionKey } from "../subscriptions/keys.js";
import type {
  DeliveryOutcome,
  EventSubscriptionConfig,
  EventWakeContext,
  SubscriptionDelivery,
} from "../subscriptions/types.js";

const START = new Date("2026-01-05T08:00:00.000Z");

function change(overrides: Partial<StateChange> = {}): StateChange {
  return {
    type: "plan",
    id: "trip",
    scope: "global",
    op: "update",
    before: { status: "draft" },
    after: { status: "active" },
    version: 2,
    actor: { kind: "user", name: "owner" },
    at: new Date().toISOString(),
    ...overrides,
  };
}

interface Call {
  where: string;
  agent: string;
  ctx: EventWakeContext;
}

describe("SubscriptionDispatcher", () => {
  let db: Database.Database;
  let bus: TypedEventBus;
  let calls: Call[];
  let outcomes: DeliveryOutcome[];
  let subscriptions: EventSubscriptionConfig[];
  let paused: boolean;
  let dispatcher: SubscriptionDispatcher;

  const delivery: SubscriptionDelivery = {
    async toSession(agent, ctx) {
      calls.push({ where: "session", agent, ctx });
      return outcomes.shift() ?? "ran";
    },
    async toRoom(agent, room, ctx) {
      calls.push({ where: `room:${room}`, agent, ctx });
      return outcomes.shift() ?? "ran";
    },
  };

  function makeDispatcher(): SubscriptionDispatcher {
    return new SubscriptionDispatcher({
      events: bus,
      getConfig: () => ({ subscriptions, rooms: { batchSeconds: 2 } }),
      db,
      delivery,
      isPaused: () => paused,
      timeZone: () => "UTC",
    });
  }

  const summaries = () => calls.map((c) => c.ctx.events.map((e) => e.summary));

  beforeEach(() => {
    vi.useFakeTimers({ now: START });
    db = new Database(":memory:");
    bus = new TypedEventBus();
    calls = [];
    outcomes = [];
    paused = false;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    dispatcher?.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("wakes an agent at once for a matching event, with a line saying what changed", async () => {
    subscriptions = [{ agent: "planner", on: "state.changed", when: { type: "plan" }, deliver: "immediate" }];
    dispatcher = makeDispatcher();
    dispatcher.start();

    bus.emit("state.changed", change());
    bus.emit("state.changed", change({ type: "note" }));
    await vi.advanceTimersByTimeAsync(0);

    expect(calls.map((c) => [c.where, c.agent])).toEqual([["session", "planner"]]);
    expect(summaries()).toEqual([["plan/trip updated by a person: status: draft → active"]]);
  });

  it("does not wake an agent for its own change unless it asks to", async () => {
    subscriptions = [
      { agent: "planner", on: "state.changed", deliver: "immediate" },
      { agent: "reviewer", on: "state.changed", deliver: "immediate", includeOwn: true },
    ];
    dispatcher = makeDispatcher();
    dispatcher.start();

    bus.emit("state.changed", change({ actor: { kind: "agent", name: "planner" } }));
    await vi.advanceTimersByTimeAsync(0);
    // planner made it, so only reviewer hears.
    expect(calls.map((c) => c.agent)).toEqual(["reviewer"]);

    bus.emit("state.changed", change({ actor: { kind: "agent", name: "reviewer" } }));
    await vi.advanceTimersByTimeAsync(0);
    // reviewer made it but asked for its own changes; planner hears someone else's.
    expect(
      calls
        .map((c) => c.agent)
        .slice(1)
        .sort(),
    ).toEqual(["planner", "reviewer"]);
  });

  it("collapses a burst into one queued turn after the batching delay", async () => {
    subscriptions = [{ agent: "planner", on: "state.changed", deliver: "queue" }];
    dispatcher = makeDispatcher();
    dispatcher.start();

    bus.emit("state.changed", change({ id: "a" }));
    await vi.advanceTimersByTimeAsync(1000);
    bus.emit("state.changed", change({ id: "b" }));
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);

    expect(calls).toHaveLength(1);
    expect(calls[0].ctx.events.map((e) => e.summary.split(" ")[0])).toEqual(["plan/a", "plan/b"]);
  });

  it("delivers a batch one window after its first event, however steadily events keep coming", async () => {
    subscriptions = [{ agent: "planner", on: "state.changed", deliver: "batch", window: "5m" }];
    dispatcher = makeDispatcher();
    dispatcher.start();

    for (let minute = 0; minute < 5; minute++) {
      bus.emit("state.changed", change({ id: `m${minute}` }));
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(calls).toHaveLength(1);
    expect(calls[0].ctx.events).toHaveLength(5);

    bus.emit("state.changed", change({ id: "late" }));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(calls).toHaveLength(2);
    expect(calls[1].ctx.events.map((e) => e.summary.split(" ")[0])).toEqual(["plan/late"]);
  });

  it("delivers a digest on its schedule, and stays quiet when there is nothing", async () => {
    subscriptions = [{ agent: "planner", on: "state.changed", deliver: "digest", every: "every 1 hour" }];
    dispatcher = makeDispatcher();
    dispatcher.start();

    bus.emit("state.changed", change({ id: "a" }));
    bus.emit("state.changed", change({ id: "b" }));
    await vi.advanceTimersByTimeAsync(59 * 60_000);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);
    expect(calls[0].ctx.events).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(calls).toHaveLength(1);
  });

  it("records events without waking anyone, and hands them to the agent's next turn once", async () => {
    subscriptions = [{ agent: "planner", on: "state.changed", deliver: "record" }];
    dispatcher = makeDispatcher();
    dispatcher.start();

    bus.emit("state.changed", change());
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(calls).toEqual([]);

    const slot = listContextSlots().find((s) => s.id === "subscriptions.inbox");
    const ctx = (agent: string) => ({ agent, projectId: null, sessionId: "s", userMessage: "hi" });
    expect(slot?.render(ctx("reviewer"))).toBeNull();
    expect(slot?.render(ctx("planner"))).toBe(
      "Things you subscribe to that happened without waking you:\n" +
        "- Mon, Jan 5, 08:00: plan/trip updated by a person: status: draft → active",
    );
    expect(slot?.render(ctx("planner"))).toBeNull();
  });

  it("retries a refused delivery a minute later without duplicating it", async () => {
    subscriptions = [{ agent: "planner", on: "state.changed", deliver: "immediate" }];
    outcomes = ["at-ceiling"];
    dispatcher = makeDispatcher();
    dispatcher.start();

    bus.emit("state.changed", change());
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(calls).toHaveLength(2);
    expect(calls[1].ctx.events).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls).toHaveLength(2);
  });

  it("holds events while paused and delivers them after", async () => {
    subscriptions = [{ agent: "planner", on: "state.changed", deliver: "immediate" }];
    paused = true;
    dispatcher = makeDispatcher();
    dispatcher.start();

    bus.emit("state.changed", change());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual([]);
    paused = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);
  });

  it("schedules nothing after it stops, even for a delivery refused on the way out", async () => {
    subscriptions = [{ agent: "planner", on: "state.changed", deliver: "immediate" }];
    let release: (outcome: DeliveryOutcome) => void = () => {};
    const slow: SubscriptionDelivery = {
      toSession: (agent, ctx) => {
        calls.push({ where: "session", agent, ctx });
        return new Promise<DeliveryOutcome>((resolve) => {
          release = resolve;
        });
      },
      toRoom: delivery.toRoom,
    };
    dispatcher = new SubscriptionDispatcher({
      events: bus,
      getConfig: () => ({ subscriptions }),
      db,
      delivery: slow,
    });
    dispatcher.start();
    bus.emit("state.changed", change());
    await vi.advanceTimersByTimeAsync(0);
    dispatcher.stop();
    release("at-ceiling");
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(calls).toHaveLength(1);
    // Still stored, so the next start delivers it rather than losing it.
    expect(dispatcher.store.allKeys()).toHaveLength(1);
  });

  it("drops events for a target that no longer exists instead of retrying for ever", async () => {
    subscriptions = [{ agent: "planner", on: "state.changed", deliver: "immediate", target: { room: "eng" } }];
    outcomes = ["gone"];
    dispatcher = makeDispatcher();
    dispatcher.start();

    bus.emit("state.changed", change());
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls.map((c) => c.where)).toEqual(["room:eng"]);
  });

  it("keeps waiting events across a restart and delivers them on the original schedule", async () => {
    subscriptions = [{ agent: "planner", on: "state.changed", deliver: "batch", window: "10m" }];
    dispatcher = makeDispatcher();
    dispatcher.start();
    bus.emit("state.changed", change());
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    dispatcher.stop();

    dispatcher = makeDispatcher();
    dispatcher.start();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(1);
  });

  it("drops what was waiting for a subscription that was removed from config", async () => {
    subscriptions = [{ agent: "planner", on: "state.changed", deliver: "digest", every: "every 1 hour" }];
    dispatcher = makeDispatcher();
    dispatcher.start();
    bus.emit("state.changed", change());
    dispatcher.stop();

    subscriptions = [];
    dispatcher = makeDispatcher();
    dispatcher.start();
    expect(dispatcher.store.allKeys()).toEqual([]);
  });

  it("listens again after a reload clears the bus", async () => {
    subscriptions = [{ agent: "planner", on: "state.changed", deliver: "immediate" }];
    dispatcher = makeDispatcher();
    dispatcher.start();
    bus.clear();
    bus.emit("state.changed", change());
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([]);

    dispatcher.restart();
    bus.emit("state.changed", change());
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
  });

  it("skips a subscription it cannot honour rather than guessing", async () => {
    subscriptions = [
      { agent: "planner", on: "state.changed", deliver: "batch" },
      { agent: "planner", on: "state.changed", deliver: "digest", every: "whenever" },
      { agent: "planner", on: "agent.pre_tool_use", deliver: "immediate" },
    ];
    dispatcher = makeDispatcher();
    dispatcher.start();
    bus.emit("state.changed", change());
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(calls).toEqual([]);
  });

  it("keys a subscription by what it receives and where it goes", () => {
    const a: EventSubscriptionConfig = { agent: "planner", on: "state.changed", when: { type: "plan", op: "update" } };
    const b: EventSubscriptionConfig = { agent: "planner", on: "state.changed", when: { op: "update", type: "plan" } };
    expect(subscriptionKey(a)).toBe(subscriptionKey(b));
    expect(subscriptionKey({ ...a, target: { room: "eng" } })).not.toBe(subscriptionKey(a));
  });
});
