/**
 * Events a subscription delivers into a room.
 *
 * Routed through the same `runPrompted` path as a scheduled wake so it
 * inherits the room's brakes. These check that it does, that it accepts the
 * room by name (config says `target: { room: eng }`), and that the outcomes the
 * dispatcher branches on are right: a retryable refusal is not a lost room.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDatabase } from "../db/schema.js";

const runAgentLoopMock = vi.fn();
vi.mock("../agent/loop.js", async () => {
  const actual = await vi.importActual<typeof import("../agent/loop.js")>("../agent/loop.js");
  return { ...actual, runAgentLoop: (...args: unknown[]) => runAgentLoopMock(...args) };
});

import type { Wake } from "../agent/wake.js";
import { type RuntimeEventPayload, TypedEventBus } from "../events.js";
import { LocalRoomBackend } from "../rooms/local.js";
import { registerRoomBackend, unregisterRoomBackend } from "../rooms/registry.js";
import { RoomStore } from "../rooms/store.js";
import { RoomWatcher } from "../rooms/watcher.js";
import type { AgentRuntime } from "../runtime.js";
import type { EventWakeContext } from "../subscriptions/types.js";

let db: Database.Database;
let store: RoomStore;
let backend: LocalRoomBackend;
const ROOM = "local:eng";
const AGENT = "planner";
/** The `wake` each turn's loop options were built with. */
let built: Array<Wake | undefined>;
let woken: Array<RuntimeEventPayload<"agent.woken">>;

function makeRuntime(opts: { paused?: boolean; rooms?: Record<string, unknown> } = {}): AgentRuntime {
  const config = {
    agents: { planner: { description: "plans" }, reviewer: { description: "reviews" } },
    providers: { local: { defaultModel: "m" } },
    agent: { defaultProvider: "local", temperature: 0.3, maxToolRounds: 8 },
    rooms: { maxWakesPerHour: 12, maxAgentTurns: 6, ...opts.rooms },
  };
  const events = new TypedEventBus();
  events.on("agent.woken", (e) => {
    woken.push(e);
  });
  return {
    db,
    events,
    getConfig: () => config,
    getOwnerId: () => undefined,
    isAgentsPaused: () => opts.paused === true,
    getResolvableTools: () => [],
    buildResolveOptions: () => ({}),
    getAgentDefinition: (name: string) => (config.agents as Record<string, unknown>)[name],
    contextDir: "/tmp/ctx",
    buildLoopOptions: ({ agentName, wake }: { agentName?: string; wake?: Wake }) => {
      built.push(wake);
      return { toolContextExtras: { agentName, wake } };
    },
  } as unknown as AgentRuntime;
}

const ctx: EventWakeContext = {
  deliver: "batch",
  instructions: "Move the calendar to match.",
  events: [
    {
      event: "state.changed",
      summary: "plan/trip updated by a person: status: draft → active",
      at: new Date().toISOString(),
    },
  ],
};

const lastPrompt = () => runAgentLoopMock.mock.calls.at(-1)?.[0] as string;
const prompts = () => runAgentLoopMock.mock.calls.map((c) => c[0] as string);

/** Rejects if `p` hasn't settled in `ms`: a turn waiting on itself never does. */
function settles<T>(p: Promise<T>, ms = 1000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`still waiting after ${ms}ms`)), ms)),
  ]);
}

beforeEach(async () => {
  built = [];
  woken = [];
  db = initDatabase(":memory:");
  store = new RoomStore(db);
  backend = new LocalRoomBackend(db, store);
  registerRoomBackend(backend);
  await backend.createRoom({ name: "eng" });
  store.subscribe({ agent: AGENT, roomRef: ROOM, deliver: "push", wakeOn: "addressed" });
  runAgentLoopMock.mockResolvedValue("Moved the dentist to Thursday.");
});

afterEach(() => {
  unregisterRoomBackend("local");
  db.close();
  vi.clearAllMocks();
});

describe("runEventWake", () => {
  it("runs a room turn that says what happened and what to do about it", async () => {
    const watcher = new RoomWatcher({ runtime: makeRuntime(), store });

    expect(await watcher.runEventWake(AGENT, ROOM, ctx)).toBe("ran");
    expect(lastPrompt()).toContain("Something you subscribe to happened. Nobody has asked you anything.");
    expect(lastPrompt()).toContain("plan/trip updated by a person: status: draft → active");
    expect(lastPrompt()).toContain("Your instructions for this subscription: Move the calendar to match.");
    expect(lastPrompt()).toContain('room(action="pass")');
  });

  it("finds the room by name as well as by ref", async () => {
    const watcher = new RoomWatcher({ runtime: makeRuntime(), store });
    expect(await watcher.runEventWake(AGENT, "eng", ctx)).toBe("ran");
  });

  it("charges the hourly wake ceiling like any other turn", async () => {
    const watcher = new RoomWatcher({ runtime: makeRuntime(), store });
    await watcher.runEventWake(AGENT, ROOM, ctx);
    expect(store.getSubscription(AGENT, ROOM)?.wakesThisHour).toBe(1);
  });

  it("reports a room the agent is not in, or that is gone, as gone", async () => {
    const watcher = new RoomWatcher({ runtime: makeRuntime(), store });
    expect(await watcher.runEventWake("reviewer", ROOM, ctx)).toBe("gone");
    expect(await watcher.runEventWake(AGENT, "nowhere", ctx)).toBe("gone");
    expect(runAgentLoopMock).not.toHaveBeenCalled();
  });

  it("holds the events while agents are paused", async () => {
    const watcher = new RoomWatcher({ runtime: makeRuntime({ paused: true }), store });
    expect(await watcher.runEventWake(AGENT, ROOM, ctx)).toBe("at-ceiling");
    expect(runAgentLoopMock).not.toHaveBeenCalled();
  });
});

describe("why a room turn runs", () => {
  const wake = { kind: "subscription", ref: "planner|state.changed||batch|room:eng||" };

  it("hands the subscription's wake to the turn and says so on the bus", async () => {
    const watcher = new RoomWatcher({ runtime: makeRuntime(), store });
    await watcher.runEventWake(AGENT, ROOM, { ...ctx, wake });

    expect(built).toEqual([wake]);
    expect(woken).toEqual([{ agent: AGENT, wake, targetKind: "room", target: ROOM }]);
  });
});

describe("runAgentWake", () => {
  const turn = { prompt: "Upkeep: two notes say the same thing.", wake: { kind: "upkeep" } };

  it("runs the caller's prompt in the room, framed like any room turn", async () => {
    const watcher = new RoomWatcher({ runtime: makeRuntime(), store });

    expect(await watcher.runAgentWake(AGENT, "eng", turn)).toBe("ran");
    expect(lastPrompt()).toContain('Room "eng".');
    expect(lastPrompt()).toContain("Upkeep: two notes say the same thing.");
    expect(lastPrompt()).toContain('room(action="pass")');
    expect(built).toEqual([turn.wake]);
    expect(woken).toEqual([{ agent: AGENT, wake: turn.wake, targetKind: "room", target: ROOM }]);
  });

  it("charges the room's hourly ceiling, the same one events and messages use", async () => {
    const watcher = new RoomWatcher({ runtime: makeRuntime(), store });
    await watcher.runAgentWake(AGENT, ROOM, turn);
    await watcher.runEventWake(AGENT, ROOM, ctx);
    expect(store.getSubscription(AGENT, ROOM)?.wakesThisHour).toBe(2);
  });

  it("says try later when the room's queue already holds this wake and drops it", async () => {
    // Under serial turn-taking a second wake for the same agent and room,
    // queued while one is waiting, is dropped. Reporting "ran" for it meant a
    // caller waking an agent for three records lost the third without knowing.
    const watcher = new RoomWatcher({ runtime: makeRuntime(), store });
    let release = () => {};
    runAgentLoopMock.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve("Done with A.");
        }),
    );
    const a = watcher.runAgentWake(AGENT, ROOM, { prompt: "Record A changed.", wake: { kind: "watch", ref: "a" } });
    await vi.waitFor(() => expect(runAgentLoopMock).toHaveBeenCalledTimes(1));

    const b = watcher.runAgentWake(AGENT, ROOM, { prompt: "Record B changed.", wake: { kind: "watch", ref: "b" } });
    const c = watcher.runAgentWake(AGENT, ROOM, { prompt: "Record C changed.", wake: { kind: "watch", ref: "c" } });

    expect(await c).toBe("at-ceiling");
    release();
    expect(await a).toBe("ran");
    expect(await b).toBe("ran");
    expect(prompts().some((p) => p.includes("Record C changed."))).toBe(false);
    expect(woken.map((e) => e.wake.ref)).toEqual(["a", "b"]);
  });

  it("turns away a wake started from inside a turn in the same room, rather than waiting on itself", async () => {
    store.subscribe({ agent: "reviewer", roomRef: ROOM, deliver: "push", wakeOn: "addressed" });
    const watcher = new RoomWatcher({ runtime: makeRuntime(), store });
    let inner: string | undefined;
    // planner's turn hands work to reviewer in the room it is in and waits.
    runAgentLoopMock.mockImplementationOnce(async () => {
      inner = await watcher.runAgentWake("reviewer", ROOM, { prompt: "Review the plan.", wake: { kind: "handoff" } });
      return "Asked reviewer.";
    });

    expect(await settles(watcher.runAgentWake(AGENT, ROOM, turn))).toBe("ran");
    expect(inner).toBe("at-ceiling");
    // The room still takes turns afterwards.
    expect(await settles(watcher.runEventWake(AGENT, ROOM, ctx))).toBe("ran");
    expect(prompts().some((p) => p.includes("Review the plan."))).toBe(false);
  });

  it("lets a wake through once the turn it was started from has ended", async () => {
    store.subscribe({ agent: "reviewer", roomRef: ROOM, deliver: "push", wakeOn: "addressed" });
    const watcher = new RoomWatcher({ runtime: makeRuntime(), store });
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let later: Promise<string> | undefined;
    // Set up inside the turn, so it runs in the turn's context even after the
    // turn is over, the way a timer armed during a turn does.
    runAgentLoopMock.mockImplementationOnce(async () => {
      later = gate.then(() =>
        watcher.runAgentWake("reviewer", ROOM, { prompt: "Review the plan.", wake: { kind: "handoff" } }),
      );
      return "Asked reviewer for later.";
    });

    await watcher.runAgentWake(AGENT, ROOM, turn);
    open();
    expect(await settles(later as Promise<string>)).toBe("ran");
    expect(lastPrompt()).toContain("Review the plan.");
  });

  it("says what woke the agent in the room's activity line, in the waker's words", async () => {
    const threaded = backend as unknown as { capabilities: { threads: boolean } };
    threaded.capabilities = { ...threaded.capabilities, threads: true };
    const watcher = new RoomWatcher({ runtime: makeRuntime({ rooms: { toolActivity: "all" } }), store });

    await watcher.runAgentWake(AGENT, ROOM, { prompt: "Record A changed.", wake: { kind: "watch", ref: "plan/a" } });

    const bodies = (await backend.fetchSince("eng", null, 50)).map((m) => m.body);
    expect(bodies).toContain("• woke: watch (plan/a)");
  });

  it("is gone for a room the agent is not in, and held while agents are paused", async () => {
    expect(await new RoomWatcher({ runtime: makeRuntime(), store }).runAgentWake("reviewer", ROOM, turn)).toBe("gone");
    const paused = new RoomWatcher({ runtime: makeRuntime({ paused: true }), store });
    expect(await paused.runAgentWake(AGENT, ROOM, turn)).toBe("at-ceiling");
    expect(runAgentLoopMock).not.toHaveBeenCalled();
    expect(woken).toEqual([]);
  });
});
