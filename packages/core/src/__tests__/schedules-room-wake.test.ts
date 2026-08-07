/**
 * A scheduled wake landing in a room.
 *
 * The point of routing this through `runPrompted` rather than giving it its own
 * delivery path is that it inherits the brakes: the hourly wake ceiling, the
 * per-room turn chain, `pass`. These check that it actually does, and that the
 * three outcomes the scheduler branches on are reported correctly — a retryable
 * refusal must not be confused with a room the agent can no longer reach.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDatabase } from "../db/schema.js";

const runAgentLoopMock = vi.fn();
vi.mock("../agent/loop.js", async () => {
  const actual = await vi.importActual<typeof import("../agent/loop.js")>("../agent/loop.js");
  return { ...actual, runAgentLoop: (...args: unknown[]) => runAgentLoopMock(...args) };
});

import { LocalRoomBackend } from "../rooms/local.js";
import { registerRoomBackend, unregisterRoomBackend } from "../rooms/registry.js";
import { RoomStore } from "../rooms/store.js";
import { RoomWatcher } from "../rooms/watcher.js";
import type { AgentRuntime } from "../runtime.js";
import type { WakeContext } from "../schedules/wake-context.js";

let db: Database.Database;
let store: RoomStore;
let backend: LocalRoomBackend;

const ROOM = "local:eng";
const AGENT = "coder";

function makeRuntime(opts: { paused?: boolean; maxWakesPerHour?: number } = {}): AgentRuntime {
  const config = {
    agents: { coder: { description: "writes code" } },
    providers: { local: { defaultModel: "m" } },
    agent: { defaultProvider: "local", temperature: 0.3, maxToolRounds: 8 },
    rooms: { maxWakesPerHour: opts.maxWakesPerHour ?? 12, maxAgentTurns: 6 },
  };
  return {
    db,
    getConfig: () => config,
    getOwnerId: () => undefined,
    isAgentsPaused: () => opts.paused === true,
    getResolvableTools: () => [],
    getAgentDefinition: (name: string) => (config.agents as Record<string, unknown>)[name],
    contextDir: "/tmp/ctx",
    buildLoopOptions: ({ agentName }: { agentName?: string }) => ({ toolContextExtras: { agentName } }),
  } as unknown as AgentRuntime;
}

function wakeContext(overrides: Partial<WakeContext> = {}): WakeContext {
  return {
    scheduleId: "a3f1",
    note: "check whether the deploy PR merged",
    kind: "once",
    source: "10 minutes",
    createdAt: new Date(Date.now() - 2 * 3600_000),
    runCount: 1,
    lateBy: 0,
    ...overrides,
  };
}

/** The prompt the fake loop was handed, so the wording can be asserted. */
function lastPrompt(): string {
  return runAgentLoopMock.mock.calls.at(-1)?.[0] as string;
}

beforeEach(async () => {
  db = initDatabase(":memory:");
  store = new RoomStore(db);
  backend = new LocalRoomBackend(db, store);
  registerRoomBackend(backend);
  await backend.createRoom({ name: "eng" });
  store.subscribe({ agent: AGENT, roomRef: ROOM, deliver: "push", wakeOn: "addressed" });
  runAgentLoopMock.mockReset();
  runAgentLoopMock.mockResolvedValue("");
});

afterEach(() => {
  unregisterRoomBackend("local");
  db.close();
  vi.clearAllMocks();
});

describe("runScheduledWake", () => {
  it("runs a turn and reports it ran", async () => {
    const watcher = new RoomWatcher({ runtime: makeRuntime(), store });

    const outcome = await watcher.runScheduledWake(AGENT, ROOM, wakeContext());

    expect(outcome).toBe("ran");
    expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
  });

  it("hands the agent its own note, which is the whole point of the wake", async () => {
    const watcher = new RoomWatcher({ runtime: makeRuntime(), store });

    await watcher.runScheduledWake(AGENT, ROOM, wakeContext());

    expect(lastPrompt()).toContain("check whether the deploy PR merged");
    expect(lastPrompt()).toContain("booked 2h ago");
    // Silence stays available: a wake that turns out to need nothing said
    // should cost one `pass`, not a paragraph of throat-clearing.
    expect(lastPrompt()).toContain('room(action="pass")');
  });

  it("tells a recurring wake how to cancel itself", async () => {
    const watcher = new RoomWatcher({ runtime: makeRuntime(), store });

    await watcher.runScheduledWake(AGENT, ROOM, wakeContext({ kind: "repeat", source: "weekdays at 9am" }));

    // The only brake on a recurrence the agent has forgotten about.
    expect(lastPrompt()).toContain("recurring wake a3f1");
    expect(lastPrompt()).toContain('schedule(action="cancel", id="a3f1")');
  });

  it("says when it fired late instead of pretending otherwise", async () => {
    const watcher = new RoomWatcher({ runtime: makeRuntime(), store });

    await watcher.runScheduledWake(AGENT, ROOM, wakeContext({ lateBy: 14 * 60_000 }));

    expect(lastPrompt()).toContain("fired 14m late");
  });

  it("charges the wake against the hourly ceiling like any other turn", async () => {
    runAgentLoopMock.mockResolvedValue("the deploy merged an hour ago");
    const watcher = new RoomWatcher({ runtime: makeRuntime(), store });

    await watcher.runScheduledWake(AGENT, ROOM, wakeContext());

    // A self-booked wake must not be a way around the deployment's brake.
    expect(store.getSubscription(AGENT, ROOM)?.wakesThisHour).toBe(1);
  });

  it("refunds the wake when the scheduled turn had nothing to say", async () => {
    const watcher = new RoomWatcher({ runtime: makeRuntime(), store });

    // Inherited from the silence refund (#345) rather than special-cased here,
    // and safe for the same reason: a turn that says nothing produces no
    // message, so it cannot feed itself another wake. A wake that fires on a
    // timer cannot either.
    await watcher.runScheduledWake(AGENT, ROOM, wakeContext());

    expect(store.getSubscription(AGENT, ROOM)?.wakesThisHour).toBe(0);
  });

  it("reports at-ceiling — retryable — when the allowance is spent", async () => {
    runAgentLoopMock.mockResolvedValue("the deploy merged an hour ago");
    const watcher = new RoomWatcher({ runtime: makeRuntime({ maxWakesPerHour: 1 }), store });

    const first = await watcher.runScheduledWake(AGENT, ROOM, wakeContext());
    const second = await watcher.runScheduledWake(AGENT, ROOM, wakeContext());

    expect(first).toBe("ran");
    expect(second).toBe("at-ceiling");
    expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
  });

  it("reports at-ceiling while agents are paused, so nothing is lost", async () => {
    const watcher = new RoomWatcher({ runtime: makeRuntime({ paused: true }), store });

    expect(await watcher.runScheduledWake(AGENT, ROOM, wakeContext())).toBe("at-ceiling");
    expect(runAgentLoopMock).not.toHaveBeenCalled();
  });

  it("reports gone when the agent no longer sits in the room", async () => {
    store.unsubscribe(AGENT, ROOM);
    const watcher = new RoomWatcher({ runtime: makeRuntime(), store });

    // Permanent, unlike a ceiling: the scheduler retires the schedule rather
    // than retrying into a room the agent left.
    expect(await watcher.runScheduledWake(AGENT, ROOM, wakeContext())).toBe("gone");
  });

  it("reports gone when the room has been archived", async () => {
    store.archiveRoom(ROOM, { by: "owner" });
    const watcher = new RoomWatcher({ runtime: makeRuntime(), store });

    expect(await watcher.runScheduledWake(AGENT, ROOM, wakeContext())).toBe("gone");
    expect(runAgentLoopMock).not.toHaveBeenCalled();
  });
});
