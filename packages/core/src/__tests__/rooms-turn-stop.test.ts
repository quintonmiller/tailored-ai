/**
 * Rooms: a turn says how it ended (#521).
 *
 * Every other place that runs an agent loop asks it why it stopped. The task
 * watcher does, and routes a stall to StallGuard. The exploratory worker does,
 * after reading the reason off the reply string classified every budget-capped
 * tick as a stall — 81 identical notes in 10 days. The chat path in the
 * benchmark harness does. The room path did not, and nothing noticed, because
 * the thing it fell back on was a regex that has never matched:
 *
 *   runs in the 2026-08-12 cohort               237
 *     with a captured stop (chat path)          105
 *     without one (room path)                   132   ← 56%
 *   stalled runs                                 12
 *     carrying an `[Agent stopped: …]` marker     0
 *
 * All twelve came back as ordinary prose, because a turn that runs out of
 * rounds now gets one tools-withheld call so it can explain itself. In a room
 * that prose is posted like any other message, nobody reads the raw output, and
 * the agent having gone in circles is a fact that existed nowhere.
 *
 * The loop was always willing to say — `onStop` has been there the whole time.
 * The watcher just never asked.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDatabase } from "../db/schema.js";

const runAgentLoopMock = vi.fn();
vi.mock("../agent/loop.js", async () => {
  const actual = await vi.importActual<typeof import("../agent/loop.js")>("../agent/loop.js");
  return { ...actual, runAgentLoop: (...args: unknown[]) => runAgentLoopMock(...args) };
});

import type { LoopStop } from "../agent/loop.js";
import { TypedEventBus } from "../events.js";
import { LocalRoomBackend } from "../rooms/local.js";
import { registerRoomBackend, unregisterRoomBackend } from "../rooms/registry.js";
import { RoomStore } from "../rooms/store.js";
import { RoomWatcher } from "../rooms/watcher.js";
import type { AgentRuntime } from "../runtime.js";

let db: Database.Database;
let store: RoomStore;
let backend: LocalRoomBackend;
let events: TypedEventBus;

const ROOM = "local:eng";

type TurnEnded = {
  rooms: string[];
  agent: string;
  stop?: LoopStop;
  stallReason: string | null;
  posted: boolean;
  error?: string;
};

function makeRuntime(): AgentRuntime {
  const config = {
    agents: { coder: { description: "writes code" } },
    providers: { local: { defaultModel: "m" } },
    agent: { defaultProvider: "local", temperature: 0.3, maxToolRounds: 8 },
    rooms: { maxWakesPerHour: 12, maxAgentTurns: 6 },
  };
  return {
    db,
    events,
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
 * One poll turn whose fake loop behaves as described, and the event it produced.
 *
 * `loop` receives the options the watcher built, which is the point: whether it
 * was handed an `onStop` at all is the thing that was missing, and a fake that
 * ignores the callback would pass this file no matter what the watcher did.
 */
async function turn(
  loop: (opts: { onStop?: (stop: LoopStop) => void }, call: number) => Promise<string> | string,
): Promise<TurnEnded[]> {
  let call = 0;
  runAgentLoopMock.mockImplementation(async (_prompt: string, opts: Record<string, any>) => loop(opts, ++call));

  const seen: TurnEnded[] = [];
  const listening = events.on("room.turn_ended", (e) => {
    seen.push(e as TurnEnded);
  });
  const watcher = new RoomWatcher({ runtime: makeRuntime(), store });
  try {
    await watcher.pollOnce("coder", ROOM);
  } finally {
    listening.dispose();
    watcher.stop();
  }
  return seen;
}

beforeEach(async () => {
  db = initDatabase(":memory:");
  store = new RoomStore(db);
  events = new TypedEventBus();
  backend = new LocalRoomBackend(db, store);
  registerRoomBackend(backend);
  const room = await backend.createRoom({ name: "eng" });
  store.subscribe({ agent: "coder", roomRef: ROOM, deliver: "poll", wakeOn: "all" });
  await backend.post(room.ref.id, { speaker: "owner", body: "coder, what is the status?" });
  runAgentLoopMock.mockReset();
});

afterEach(() => {
  unregisterRoomBackend("local");
  db.close();
  vi.clearAllMocks();
});

describe("a room turn reports why it ended (#521)", () => {
  it("asks the loop for its stop", async () => {
    let asked: unknown;
    await turn((opts) => {
      asked = opts.onStop;
      return "status is green";
    });

    // The whole bug in one assertion. Everything below can be satisfied by a
    // watcher that guesses; only this says it is being told.
    expect(typeof asked).toBe("function");
  });

  it("reports a stall that came back as an ordinary-looking answer", async () => {
    // What all twelve stalls in the cohort looked like: the detector fired, the
    // tools-withheld call produced prose, and the room got a message that reads
    // like an answer. Nothing in the text distinguishes it.
    const seen = await turn((opts) => {
      opts.onStop?.({ kind: "repeated-calls", period: 1 });
      return "Sure — let me know if there is anything else.";
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].stop).toEqual({ kind: "repeated-calls", period: 1 });
    expect(seen[0].stallReason).toBe("repeated identical tool calls");
    // It spoke, which is exactly why this is worth reporting: the room is now
    // carrying a stalled turn's output as an answer.
    expect(seen[0].posted).toBe(true);
    expect(seen[0].rooms).toEqual([ROOM]);
    expect(seen[0].agent).toBe("coder");
  });

  it("says nothing about a stall when the turn simply finished", async () => {
    const seen = await turn((opts) => {
      opts.onStop?.({ kind: "complete" });
      return "status is green";
    });

    expect(seen[0].stallReason).toBeNull();
    expect(seen[0].stop).toEqual({ kind: "complete" });
  });

  it("does not let a tidy correction round bury the stall that caused it", async () => {
    // The correction round is a second loop, and it usually ends cleanly — it
    // is one instruction with no tools to get stuck on. Taking the last stop
    // would therefore report almost every corrected stall as complete, which is
    // the wrong answer to the only question this field is asked.
    const seen = await turn((opts, call) => {
      if (call === 1) {
        opts.onStop?.({ kind: "max-rounds", rounds: 8, answered: true });
        // Trips the correction round: the model wrote the call instead of
        // making it.
        return "room(action=pass)";
      }
      opts.onStop?.({ kind: "complete" });
      return "Nothing to add.";
    });

    expect(runAgentLoopMock).toHaveBeenCalledTimes(2);
    expect(seen[0].stop?.kind).toBe("max-rounds");
    expect(seen[0].stallReason).toBe("max tool rounds reached");
  });

  it("takes the correction round's stop when the first half was clean", async () => {
    const seen = await turn((opts, call) => {
      if (call === 1) {
        opts.onStop?.({ kind: "complete" });
        return "room(action=pass)";
      }
      opts.onStop?.({ kind: "repeated-calls", period: 2 });
      return "Nothing to add.";
    });

    expect(seen[0].stop).toEqual({ kind: "repeated-calls", period: 2 });
  });

  it("reports a turn that ended by throwing", async () => {
    // An event that only fires when things go well is worse than no event: the
    // gap reads as good news. A caller counting turns would silently under-count
    // exactly the ones worth counting.
    const seen = await turn(() => {
      throw new Error("provider exploded");
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].error).toBe("provider exploded");
    expect(seen[0].stop).toBeUndefined();
    expect(seen[0].stallReason).toBeNull();
    expect(seen[0].posted).toBe(false);
  });
});
