/**
 * Rooms: what a turn has to do to be charged its wake (#345).
 *
 * `maxWakesPerHour` is the deployment-wide brake on two agents talking each
 * other into the ground, and the refund is the escape hatch that keeps it from
 * silencing an agent that read the room and had nothing to add. The refund's
 * safety argument is that a silent agent produces no incoming message and so
 * cannot feed itself another wake.
 *
 * A turn whose only tool call was `room(action="post")` broke that argument in
 * both directions and was refunded anyway: `usedTools` excludes the whole
 * `room` tool so that `pass` reads as silence, and `deliverReply` returns null
 * precisely *because* the tool already posted. So the documented way to speak —
 * the only way to address someone, set `notify`, or post to a room you did not
 * wake in — was the one way that cost nothing.
 *
 * These run a real turn through the poll path with the agent loop mocked, which
 * is the only way to see the interaction: every piece is individually correct.
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
import { roomPostedKey, RoomWatcher } from "../rooms/watcher.js";
import type { AgentRuntime } from "../runtime.js";

let db: Database.Database;
let store: RoomStore;
let backend: LocalRoomBackend;

const ROOM = "local:eng";

function makeRuntime(): AgentRuntime {
  const config = {
    agents: { coder: { description: "writes code" }, supervisor: {} },
    providers: { local: { defaultModel: "m" } },
    agent: { defaultProvider: "local", temperature: 0.3, maxToolRounds: 8 },
    rooms: { maxWakesPerHour: 12, maxAgentTurns: 6 },
  };
  return {
    db,
    getConfig: () => config,
    getOwnerId: () => undefined,
    isAgentsPaused: () => false,
    getResolvableTools: () => [],
    getAgentDefinition: (name: string) => (config.agents as Record<string, unknown>)[name],
    contextDir: "/tmp/ctx",
    buildLoopOptions: ({ agentName }: { agentName?: string }) => ({
      toolContextExtras: { agentName },
    }),
  } as unknown as AgentRuntime;
}

/**
 * Drive one poll turn whose fake loop behaves like the agent did the given
 * thing. `post` writes the same marker the real `room` tool writes, after the
 * backend call, and returns closing text — which is what makes the turn look
 * silent to `deliverReply`.
 */
async function runTurnWhere(
  behaviour: (opts: {
    onToolCall?: (name: string, args: Record<string, unknown>) => void;
    workingMemory: Map<string, string>;
  }) => string,
): Promise<void> {
  runAgentLoopMock.mockImplementation(async (_prompt: string, opts: Record<string, any>) => {
    const workingMemory = opts.toolContextExtras.workingMemory as Map<string, string>;
    return behaviour({ onToolCall: opts.onToolCall, workingMemory });
  });
  const watcher = new RoomWatcher({ runtime: makeRuntime(), store });
  await watcher.pollOnce("coder", ROOM);
}

function wakesThisHour(): number {
  return store.getSubscription("coder", ROOM)?.wakesThisHour ?? -1;
}

beforeEach(async () => {
  db = initDatabase(":memory:");
  store = new RoomStore(db);
  backend = new LocalRoomBackend(db, store);
  registerRoomBackend(backend);
  const room = await backend.createRoom({ name: "eng" });
  store.subscribe({ agent: "coder", roomRef: ROOM, deliver: "poll", wakeOn: "all" });
  // A human speaking is what makes the turn wakeworthy and keeps the
  // agent-turn counter honest for the third assertion.
  await backend.post(room.ref.id, { speaker: "owner", body: "coder, what is the status?" });
  runAgentLoopMock.mockReset();
});

afterEach(() => {
  unregisterRoomBackend("local");
  db.close();
  vi.clearAllMocks();
});

describe("wake accounting: a tool post is not silence (#345)", () => {
  it("charges the wake when the turn's only tool call was room(post)", async () => {
    await runTurnWhere(({ onToolCall, workingMemory }) => {
      onToolCall?.("room", { action: "post", body: "status is green" });
      workingMemory.set(roomPostedKey(ROOM), "true");
      // Closing text the agent produced alongside the tool call. deliverReply
      // suppresses it as a duplicate, which is what used to make the turn
      // read as silent.
      return "I posted the update.";
    });

    expect(wakesThisHour()).toBe(1);
  });

  it("charges a post to a room the turn did not wake in", async () => {
    // The refund asks whether the agent was silent, not whether it spoke in
    // this room. A post anywhere arms someone's wake, so it cannot be free.
    //
    // The closing text has to be empty for this to mean anything: with text,
    // `deliverReply` posts it into the woken room — the `room:posted:` marker
    // it checks is the *other* room's — and the turn is charged for that
    // instead, which would make this pass without the fix.
    await runTurnWhere(({ onToolCall, workingMemory }) => {
      onToolCall?.("room", { action: "post", room: "ops" });
      workingMemory.set(roomPostedKey("local:ops"), "true");
      return "";
    });

    expect(wakesThisHour()).toBe(1);
  });

  it("still refunds a pass, which is the case the refund exists for", async () => {
    await runTurnWhere(({ onToolCall, workingMemory }) => {
      onToolCall?.("room", { action: "pass" });
      workingMemory.set(`room:passed:${ROOM}`, "true");
      return "";
    });

    expect(wakesThisHour()).toBe(0);
  });

  it("still refunds a turn that said nothing and did nothing", async () => {
    await runTurnWhere(() => "");

    expect(wakesThisHour()).toBe(0);
  });

  it("does not reset the agent-turn counter for a tool post", async () => {
    // The guard against the naive fix. Making `post` set `usedTools` would
    // charge the wake, but it would also zero `agent_turns` on every tool
    // post — so two agents chatting through the tool would hold the depth cap
    // open forever, removing the other brake while fixing this one.
    store.noteRoomTurn(ROOM, false, "supervisor");
    const before = store.agentTurns(ROOM);
    expect(before).toBeGreaterThan(0);

    await runTurnWhere(({ onToolCall, workingMemory }) => {
      onToolCall?.("room", { action: "post" });
      workingMemory.set(roomPostedKey(ROOM), "true");
      return "posted";
    });

    expect(store.agentTurns(ROOM)).toBe(before);
  });

  it("charges a turn that used a real tool, as it always did", async () => {
    await runTurnWhere(({ onToolCall }) => {
      onToolCall?.("web_search", { query: "status" });
      return "Here is what I found.";
    });

    expect(wakesThisHour()).toBe(1);
  });
});
