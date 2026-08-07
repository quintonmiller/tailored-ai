/**
 * What a timed wake reads, and what it leaves behind.
 *
 * Check-ins and self-booked schedules used to fetch from a null cursor and
 * never advance it, so every firing re-rendered the same messages into a prompt
 * that is persisted to the session. Measured on a production deployment: 124
 * check-in prompts collapsing to 23 distinct bodies, one 1,115-token block
 * stored 23 times, ~89% of all prompt duplication in the database.
 *
 * The behaviour was untested, which is why it survived. These pin it.
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

function makeRuntime(): AgentRuntime {
  const config = {
    agents: { coder: { description: "writes code" } },
    providers: { local: { defaultModel: "m" } },
    agent: { defaultProvider: "local", temperature: 0.3, maxToolRounds: 8 },
    rooms: { maxWakesPerHour: 50, maxAgentTurns: 6 },
  };
  return {
    db,
    getConfig: () => config,
    getOwnerId: () => undefined,
    isAgentsPaused: () => false,
    getResolvableTools: () => [],
    getAgentDefinition: (name: string) => (config.agents as Record<string, unknown>)[name],
    contextDir: "/tmp/ctx",
    buildLoopOptions: ({ agentName }: { agentName?: string }) => ({ toolContextExtras: { agentName } }),
  } as unknown as AgentRuntime;
}

function wakeContext(): WakeContext {
  return {
    scheduleId: "a3f1",
    note: "check whether the deploy PR merged",
    kind: "once",
    source: "10 minutes",
    createdAt: new Date(Date.now() - 3600_000),
    runCount: 1,
    lateBy: 0,
  };
}

async function say(speaker: string, body: string): Promise<void> {
  await backend.post("eng", { speaker, to: [], body });
}

function prompts(): string[] {
  return runAgentLoopMock.mock.calls.map((c) => c[0] as string);
}

function lastPrompt(): string {
  return prompts().at(-1) ?? "";
}

beforeEach(async () => {
  db = initDatabase(":memory:");
  store = new RoomStore(db);
  backend = new LocalRoomBackend(db, store);
  registerRoomBackend(backend);
  await backend.createRoom({ name: "eng" });
  store.subscribe({ agent: AGENT, roomRef: ROOM, deliver: "poll", wakeOn: "all", checkInMinutes: 60 });
  runAgentLoopMock.mockReset();
  // Speak, so the turn is not refunded as silence and the run counts.
  runAgentLoopMock.mockResolvedValue("noted");
});

afterEach(() => {
  unregisterRoomBackend("local");
  db.close();
  vi.clearAllMocks();
});

describe("check-in reads from the cursor", () => {
  it("shows the backlog on a first look, when the cursor is null", async () => {
    await say("quinton", "deploy is blocked on review");
    const watcher = new RoomWatcher({ runtime: makeRuntime(), store });

    await watcher.runCheckIn(AGENT, ROOM);

    // No context regression: an agent that has never read the room still gets it.
    expect(lastPrompt()).toContain("deploy is blocked on review");
  });

  it("does not re-send a message it already showed", async () => {
    await say("quinton", "deploy is blocked on review");
    const watcher = new RoomWatcher({ runtime: makeRuntime(), store });

    await watcher.runCheckIn(AGENT, ROOM);
    await watcher.runCheckIn(AGENT, ROOM);

    // The whole bug: this line appeared in every check-in prompt for ever.
    const seen = prompts().filter((p) => p.includes("deploy is blocked on review"));
    expect(seen).toHaveLength(1);
  });

  it("says nothing is new rather than repeating what is old", async () => {
    // A check-in that finds nothing worth saying is the common case, and the
    // one where the old behaviour was worst: silence posts nothing, so the
    // room is genuinely unchanged and the next firing re-read the same block.
    runAgentLoopMock.mockResolvedValue("");
    await say("quinton", "deploy is blocked on review");
    const watcher = new RoomWatcher({ runtime: makeRuntime(), store });

    await watcher.runCheckIn(AGENT, ROOM);
    await watcher.runCheckIn(AGENT, ROOM);

    // "Nothing changed" is the fact a check-in exists to establish, and was
    // the one thing it could not previously express.
    expect(lastPrompt()).toContain("Nothing new here since your last turn.");
    expect(lastPrompt()).not.toContain("New since your last turn:");
  });

  it("treats the agent's own reply as new, condensed rather than quoted whole", async () => {
    runAgentLoopMock.mockResolvedValue("x".repeat(400));
    await say("quinton", "deploy is blocked on review");
    const watcher = new RoomWatcher({ runtime: makeRuntime(), store });

    await watcher.runCheckIn(AGENT, ROOM);
    await watcher.runCheckIn(AGENT, ROOM);

    // Its own post really did arrive after it last read, so it is new. It is
    // also already in the session as the reply it just made, which is what
    // condenseOwnLine is for — the point is that it is not re-quoted in full.
    expect(lastPrompt()).toContain("your own message, in full above");
    expect(lastPrompt()).not.toContain("x".repeat(400));
  });

  it("shows only what arrived since the previous check-in", async () => {
    await say("quinton", "first message");
    const watcher = new RoomWatcher({ runtime: makeRuntime(), store });
    await watcher.runCheckIn(AGENT, ROOM);

    await say("quinton", "second message");
    await watcher.runCheckIn(AGENT, ROOM);

    expect(lastPrompt()).toContain("second message");
    expect(lastPrompt()).not.toContain("first message");
  });

  it("advances the cursor, so the next wake starts where it stopped", async () => {
    await say("quinton", "deploy is blocked on review");
    const before = store.getSubscription(AGENT, ROOM)?.cursor ?? null;
    const watcher = new RoomWatcher({ runtime: makeRuntime(), store });

    await watcher.runCheckIn(AGENT, ROOM);

    const after = store.getSubscription(AGENT, ROOM)?.cursor ?? null;
    expect(before).toBeNull();
    expect(after).not.toBeNull();
  });

  it("labels the block as new rather than as unattributed recent chatter", async () => {
    await say("quinton", "deploy is blocked on review");
    const watcher = new RoomWatcher({ runtime: makeRuntime(), store });

    await watcher.runCheckIn(AGENT, ROOM);

    expect(lastPrompt()).toContain("New since your last turn:");
  });
});

describe("scheduled wake reads from the cursor", () => {
  it("does not re-send a message it already showed", async () => {
    await say("quinton", "deploy is blocked on review");
    const watcher = new RoomWatcher({ runtime: makeRuntime(), store });

    await watcher.runScheduledWake(AGENT, ROOM, wakeContext());
    await watcher.runScheduledWake(AGENT, ROOM, wakeContext());

    const seen = prompts().filter((p) => p.includes("deploy is blocked on review"));
    expect(seen).toHaveLength(1);
  });

  it("still hands back the note, which is the wake", async () => {
    runAgentLoopMock.mockResolvedValue("");
    const watcher = new RoomWatcher({ runtime: makeRuntime(), store });

    await watcher.runScheduledWake(AGENT, ROOM, wakeContext());
    await watcher.runScheduledWake(AGENT, ROOM, wakeContext());

    // The note is not room state, so it repeats by design — every firing of a
    // recurrence has to carry it.
    expect(lastPrompt()).toContain("check whether the deploy PR merged");
    expect(lastPrompt()).toContain("Nothing new here since your last turn.");
  });

  it("leaves the cursor alone when the wake never ran", async () => {
    await say("quinton", "deploy is blocked on review");
    store.unsubscribe(AGENT, ROOM);
    const watcher = new RoomWatcher({ runtime: makeRuntime(), store });

    // A wake with nowhere to land must not consume the messages it never showed.
    expect(await watcher.runScheduledWake(AGENT, ROOM, wakeContext())).toBe("gone");
    expect(runAgentLoopMock).not.toHaveBeenCalled();
  });
});
