/**
 * An agent in six rooms, shown one.
 *
 * A wake prompt names the room that woke the agent and carries that room's new
 * messages. For an agent in one room that is the whole world; for an agent in
 * six it is a keyhole, and the rooms it is mid-conversation in are invisible
 * unless they happen to have spoken last.
 *
 * Two things are pinned here, and the split between them is the point:
 *
 *   the view  — state, so it is re-rendered every turn and rides behind the
 *               history. It must NEVER reach the wake prompt, because the wake
 *               prompt is persisted as the record of what the agent was asked,
 *               and a view stored as a record is what puts one block in a
 *               session twenty times over.
 *   the how-to — standing knowledge, identical every turn, so it rides in the
 *               system prompt where it is paid for once.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearContextSlots, listContextSlots, renderContextSlots } from "../agent/context-slots.js";
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

let db: Database.Database;
let store: RoomStore;
let backend: LocalRoomBackend;
const AGENT = "lila";

function makeRuntime(crossRoomView?: Record<string, unknown>): AgentRuntime {
  const config = {
    agents: { lila: { description: "companion" } },
    providers: { local: { defaultModel: "m" } },
    agent: { defaultProvider: "local", temperature: 0.3, maxToolRounds: 8 },
    rooms: { maxWakesPerHour: 50, maxAgentTurns: 6, identities: { quinton: "1234" }, crossRoomView },
  };
  return {
    db,
    getConfig: () => config,
    getOwnerId: () => "1234",
    isAgentsPaused: () => false,
    getResolvableTools: () => [],
    getAgentDefinition: (name: string) => (config.agents as Record<string, unknown>)[name],
    contextDir: "/tmp/ctx",
    buildLoopOptions: ({ agentName }: { agentName?: string }) => ({ toolContextExtras: { agentName } }),
  } as unknown as AgentRuntime;
}

/** Two rooms, the agent subscribed to each. No traffic yet. */
async function seedTwoRooms() {
  await backend.createRoom({ name: "quinton-lila" });
  await backend.createRoom({ name: "enzo-lila" });
  store.subscribe({ agent: AGENT, roomRef: "local:quinton-lila", deliver: "poll", wakeOn: "all" });
  store.subscribe({ agent: AGENT, roomRef: "local:enzo-lila", deliver: "poll", wakeOn: "all" });
}

/**
 * Traffic, posted after `start()`.
 *
 * `start()` drains each armed subscription, so anything posted before it is
 * already consumed by the time an explicit `pollOnce` runs and the turn never
 * happens — which looks exactly like the feature not working.
 */
async function postTraffic() {
  await backend.post("enzo-lila", { speaker: "enzo", to: [], body: "are you coming over" });
  await backend.post("quinton-lila", { speaker: "quinton", to: [AGENT], body: "how was your day?" });
}

beforeEach(async () => {
  db = initDatabase(":memory:");
  store = new RoomStore(db);
  backend = new LocalRoomBackend(db, store);
  registerRoomBackend(backend);
  clearContextSlots();
  runAgentLoopMock.mockReset();
  runAgentLoopMock.mockResolvedValue("noted");
});

afterEach(() => {
  clearContextSlots();
  unregisterRoomBackend("local");
  db.close();
  vi.clearAllMocks();
});

describe("the cross-room view", () => {
  it("is off unless asked for, so no deployment pays for it by accident", async () => {
    await seedTwoRooms();
    const watcher = new RoomWatcher({ runtime: makeRuntime(), store });
    await postTraffic();
    await watcher.pollOnce(AGENT, "local:quinton-lila");

    expect(renderContextSlots({ agent: AGENT, projectId: null, sessionId: "s", userMessage: "" }).turn).toBe("");
  });

  it("shows the other room, and marks the one being answered", async () => {
    await seedTwoRooms();
    const watcher = new RoomWatcher({ runtime: makeRuntime({ enabled: true, messages: 24, floorPerRoom: 2 }), store });
    await postTraffic();

    let rendered = "";
    runAgentLoopMock.mockImplementation(async () => {
      // Read mid-turn: the slot is populated for the duration of the turn only.
      rendered = renderContextSlots({ agent: AGENT, projectId: null, sessionId: "s", userMessage: "" }).turn;
      return "ok";
    });
    await watcher.pollOnce(AGENT, "local:quinton-lila");

    expect(rendered).toContain("quinton-lila — you are here");
    expect(rendered).toContain("enzo-lila");
    // The other room's content, which the wake prompt alone would never carry.
    expect(rendered).toContain("are you coming over");
  });

  it("never reaches the wake prompt, which is the record of what was asked", async () => {
    await seedTwoRooms();
    const watcher = new RoomWatcher({ runtime: makeRuntime({ enabled: true, messages: 24, floorPerRoom: 2 }), store });
    await postTraffic();
    await watcher.pollOnce(AGENT, "local:quinton-lila");

    const prompt = runAgentLoopMock.mock.calls.at(-1)?.[0] as string;
    expect(prompt).toContain("how was your day?");
    expect(prompt).not.toContain("are you coming over");
    expect(prompt).not.toContain("you are here");
  });

  it("is cleared when the turn ends, so it cannot leak into an unrelated one", async () => {
    await seedTwoRooms();
    const watcher = new RoomWatcher({ runtime: makeRuntime({ enabled: true, messages: 24, floorPerRoom: 2 }), store });
    await postTraffic();
    await watcher.pollOnce(AGENT, "local:quinton-lila");

    expect(renderContextSlots({ agent: AGENT, projectId: null, sessionId: "s", userMessage: "" }).turn).toBe("");
  });

  it("stays quiet for an agent that only watches one room", async () => {
    await backend.createRoom({ name: "solo" });
    store.subscribe({ agent: AGENT, roomRef: "local:solo", deliver: "poll", wakeOn: "all" });

    const watcher = new RoomWatcher({ runtime: makeRuntime({ enabled: true, messages: 24, floorPerRoom: 2 }), store });
    await backend.post("solo", { speaker: "quinton", to: [AGENT], body: "hello" });
    let rendered = "x";
    runAgentLoopMock.mockImplementation(async () => {
      rendered = renderContextSlots({ agent: AGENT, projectId: null, sessionId: "s", userMessage: "" }).turn;
      return "ok";
    });
    await watcher.pollOnce(AGENT, "local:solo");

    expect(rendered).toBe("");
  });
});

describe("the multi-room how-to", () => {
  it("is standing knowledge, not per-turn state", async () => {
    await seedTwoRooms();
    const watcher = new RoomWatcher({ runtime: makeRuntime({ enabled: true }), store });

    // Placement is the whole reason this is a separate slot: identical every
    // turn, so it belongs in the cacheable prefix rather than behind history.
    const byId = new Map(listContextSlots().map((s) => [s.id, s]));
    expect(byId.get("rooms.multi_room_howto")?.refresh).toBe("reload");
    expect(byId.get("rooms.view")?.refresh).toBe("turn");
  });

  it("names the tool call for speaking elsewhere", async () => {
    await seedTwoRooms();
    const watcher = new RoomWatcher({ runtime: makeRuntime({ enabled: true }), store });

    const out = renderContextSlots({ agent: AGENT, projectId: null, sessionId: "s", userMessage: "" }).reload;
    // The gap that produced `[message to enzo]` as a reply prefix: the
    // capability existed and nothing in the agent's context mentioned it.
    expect(out).toContain('room(action="post"');
    expect(out).toContain('room(action="dm"');
  });

  it("says nothing to an agent in a single room", async () => {
    await backend.createRoom({ name: "solo" });
    store.subscribe({ agent: AGENT, roomRef: "local:solo", deliver: "poll", wakeOn: "all" });
    const watcher = new RoomWatcher({ runtime: makeRuntime({ enabled: true }), store });

    expect(renderContextSlots({ agent: AGENT, projectId: null, sessionId: "s", userMessage: "" }).reload).toBe("");
  });
});
