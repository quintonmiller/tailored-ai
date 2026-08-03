/**
 * Combined wakes: one turn that reads several rooms.
 *
 * The property every test here is really about is that batching is opt-in and
 * inert until two rooms ask for it. A deployment that sets nothing, or sets
 * `batch: true` in one place, must behave exactly as it did before this
 * existed — which is why the partition tests come first and the rest of the
 * suite is left untouched as the proof.
 *
 * The rest is the machinery a combined turn needs that a single-room one gets
 * for free: locks taken in an order two agents can agree on, one wake charged
 * rather than one per room, cursors that record what was shown, and a reply
 * path that refuses to guess which room a bare sentence was for.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runAgentLoopMock = vi.fn(async () => "");
vi.mock("../agent/loop.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent/loop.js")>();
  return {
    ...actual,
    // Only the model call is faked; estimateTokens is the real one, because
    // the transcript budget is measured with it.
    runAgentLoop: (...args: unknown[]) => runAgentLoopMock(...(args as [])),
  };
});

import { initDatabase } from "../db/schema.js";
import { TypedEventBus } from "../events.js";
import { IdentityResolver } from "../rooms/identities.js";
import { LocalRoomBackend } from "../rooms/local.js";
import { registerRoomBackend, unregisterRoomBackend } from "../rooms/registry.js";
import { RoomStore, type RoomSubscription } from "../rooms/store.js";
import type { RoomMessage } from "../rooms/types.js";
import type { WakeEntry } from "../rooms/wake-queue.js";
import { RoomWatcher, selectBatchTranscript, WAKE_ROOMS_KEY } from "../rooms/watcher.js";
import type { AgentRuntime } from "../runtime.js";

let db: Database.Database;
let store: RoomStore;
let backend: LocalRoomBackend;

beforeEach(async () => {
  db = initDatabase(":memory:");
  store = new RoomStore(db);
  backend = new LocalRoomBackend(db, store);
  registerRoomBackend(backend);
  for (const name of ["eng", "ops", "ideas"]) await backend.createRoom({ name });
  runAgentLoopMock.mockReset();
  runAgentLoopMock.mockResolvedValue("");
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  unregisterRoomBackend("local");
  db.close();
  vi.restoreAllMocks();
});

/** What a test wants to differ from the ordinary deployment shape. */
interface RuntimeOverrides {
  /** 0 turns batching off entirely — the floor is what makes it legal. */
  minWakeIntervalMinutes?: number;
  paused?: (kind: "human" | "autonomous") => boolean;
}

/**
 * Runtime double carrying only what a room turn touches. `resolveAgent` and
 * `findOrCreateSession` run for real against this config and the real database,
 * so a turn that would blow up in production blows up here too.
 */
function makeRuntime(agents: string[] = ["coder"], over: RuntimeOverrides = {}): AgentRuntime {
  return {
    db,
    events: new TypedEventBus(),
    contextDir: "/tmp/rooms-batched-wake-test",
    getConfig: () => ({
      agents: Object.fromEntries(agents.map((a) => [a, {}])),
      agent: { defaultProvider: "local", extraInstructions: "", temperature: 0.3, maxToolRounds: 5 },
      providers: { local: { defaultModel: "test-model" } },
      defaultChannel: "local",
      rooms: {
        identities: { alex: { human: { local: "u-alex" } } },
        // Batching refuses to run without a per-agent floor, because the hourly
        // ceiling counts one room at a time and a combined turn spans several.
        // Every test that expects a combined turn needs one set.
        minWakeIntervalMinutes: over.minWakeIntervalMinutes ?? 5,
      },
    }),
    getOwnerId: () => undefined,
    isAgentsPaused: (kind: "human" | "autonomous") => over.paused?.(kind) ?? false,
    getResolvableTools: () => [],
    buildLoopOptions: () => ({ toolContextExtras: {} }),
  } as unknown as AgentRuntime;
}

function makeWatcher(agents?: string[], over?: RuntimeOverrides): RoomWatcher {
  return new RoomWatcher({ runtime: makeRuntime(agents, over), store });
}

/** A subscription row that really exists — the wake budget is a SQL UPDATE. */
function subscribe(agent: string, roomRef: string, batch: boolean): RoomSubscription {
  return store.subscribe({ agent, roomRef, wakeOn: "all", batch, source: "config" });
}

let messageSeq = 0;
function message(roomId: string, over: Partial<RoomMessage> = {}): RoomMessage {
  messageSeq += 1;
  const seq = String(messageSeq).padStart(16, "0");
  return {
    id: seq,
    room: { backend: "local", id: roomId },
    cursor: seq,
    raw: "something happened",
    body: "something happened",
    to: [],
    mentions: [],
    authorId: "alex",
    authorLabel: "alex",
    speaker: "alex",
    fromSelf: false,
    createdAt: "2026-08-02 12:00:00",
    ...over,
  };
}

/** Serve each room a fixed backlog, so timestamps and cursors are ours to set. */
function stubBacklog(watcher: RoomWatcher, byRoom: Record<string, RoomMessage[]>): void {
  (watcher as unknown as { fetchBacklog: (s: RoomSubscription) => Promise<RoomMessage[]> }).fetchBacklog = async (
    sub: RoomSubscription,
  ) => byRoom[sub.roomRef] ?? [];
}

const internals = (watcher: RoomWatcher) =>
  watcher as unknown as {
    onWakeDue(entry: WakeEntry): void;
    runBatchedWake(agent: string, subs: RoomSubscription[]): Promise<void>;
    dispatchWake(sub: RoomSubscription, key: string): void;
    onRoomTurn(roomRef: string, key: string, fn: () => Promise<void>): Promise<void>;
    runBatchedTurn(agent: string, subs: RoomSubscription[]): Promise<void>;
    buildBatchedPrompt(
      agent: string,
      label: string,
      sections: Array<{
        sub: RoomSubscription;
        room: { name: string; purpose?: string } | null;
        messages: RoomMessage[];
      }>,
      identities: IdentityResolver,
      mustInclude?: Iterable<string>,
    ): { prompt: string; shown: Map<string, RoomMessage[]> };
  };

function entry(agent: string, roomRefs: string[]): WakeEntry {
  return { agent, targets: new Map(roomRefs.map((ref) => [ref, new Set(["message" as const])])) };
}

/** The hourly ceiling is a SQL counter, so it is read back from SQL. */
const wakesFor = (agent: string, roomRef: string) =>
  (
    db
      .prepare("SELECT wakes_this_hour AS n FROM room_subscriptions WHERE agent = ? AND room_ref = ?")
      .get(agent, roomRef) as { n: number }
  ).n;

// --------------------------------------------------------------------------
// The flag
// --------------------------------------------------------------------------

describe("room_subscriptions.batch", () => {
  it("is off unless a subscription asks for it", () => {
    const sub = store.subscribe({ agent: "coder", roomRef: "local:eng" });
    expect(sub.batch).toBe(false);
  });

  it("round-trips through the store", () => {
    const sub = store.subscribe({ agent: "coder", roomRef: "local:eng", batch: true });
    expect(sub.batch).toBe(true);
    expect(store.getSubscription("coder", "local:eng")?.batch).toBe(true);
  });

  it("is left alone by a caller that says nothing about it", () => {
    // `invite` and `create` have no opinion on batching, exactly as they have
    // none on wake policy, and must not write the default over a real setting.
    store.subscribe({ agent: "coder", roomRef: "local:eng", batch: true });
    store.subscribe({ agent: "coder", roomRef: "local:eng", wakeOn: "all" });
    expect(store.getSubscription("coder", "local:eng")?.batch).toBe(true);
  });

  it("can be turned back off", () => {
    store.subscribe({ agent: "coder", roomRef: "local:eng", batch: true });
    store.subscribe({ agent: "coder", roomRef: "local:eng", batch: false });
    expect(store.getSubscription("coder", "local:eng")?.batch).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Partitioning — the "nothing changes unless you ask" guarantee
// --------------------------------------------------------------------------

describe("RoomWatcher.onWakeDue partitioning", () => {
  it("leaves an entry with no batched rooms entirely alone", () => {
    subscribe("coder", "local:eng", false);
    subscribe("coder", "local:ops", false);
    const watcher = makeWatcher();
    const batched = vi.spyOn(internals(watcher), "runBatchedWake").mockResolvedValue(undefined);
    const solo = vi.spyOn(internals(watcher), "dispatchWake").mockImplementation(() => {});

    internals(watcher).onWakeDue(entry("coder", ["local:eng", "local:ops"]));

    expect(batched).not.toHaveBeenCalled();
    expect(solo).toHaveBeenCalledTimes(2);
  });

  it("keeps a single batched room on the per-room path", () => {
    // One room batched with nothing is an ordinary wake with a stranger prompt
    // and a worse reply path. Turning the flag on in one place changes nothing.
    subscribe("coder", "local:eng", true);
    subscribe("coder", "local:ops", false);
    const watcher = makeWatcher();
    const batched = vi.spyOn(internals(watcher), "runBatchedWake").mockResolvedValue(undefined);
    const solo = vi.spyOn(internals(watcher), "dispatchWake").mockImplementation(() => {});

    internals(watcher).onWakeDue(entry("coder", ["local:eng", "local:ops"]));

    expect(batched).not.toHaveBeenCalled();
    expect(solo).toHaveBeenCalledTimes(2);
  });

  it("combines two batched rooms into one turn", () => {
    subscribe("coder", "local:eng", true);
    subscribe("coder", "local:ops", true);
    const watcher = makeWatcher();
    const batched = vi.spyOn(internals(watcher), "runBatchedWake").mockResolvedValue(undefined);
    const solo = vi.spyOn(internals(watcher), "dispatchWake").mockImplementation(() => {});

    internals(watcher).onWakeDue(entry("coder", ["local:eng", "local:ops"]));

    expect(batched).toHaveBeenCalledTimes(1);
    expect(batched.mock.calls[0][1].map((s: RoomSubscription) => s.roomRef).sort()).toEqual(["local:eng", "local:ops"]);
    expect(solo).not.toHaveBeenCalled();
  });

  it("runs the batched rooms together and the rest one at a time", () => {
    subscribe("coder", "local:eng", true);
    subscribe("coder", "local:ops", true);
    subscribe("coder", "local:ideas", false);
    const watcher = makeWatcher();
    const batched = vi.spyOn(internals(watcher), "runBatchedWake").mockResolvedValue(undefined);
    const solo = vi.spyOn(internals(watcher), "dispatchWake").mockImplementation(() => {});

    internals(watcher).onWakeDue(entry("coder", ["local:eng", "local:ops", "local:ideas"]));

    expect(batched.mock.calls[0][1]).toHaveLength(2);
    expect(solo).toHaveBeenCalledTimes(1);
    expect(solo.mock.calls[0][0].roomRef).toBe("local:ideas");
  });

  it("skips a room whose subscription went away while the entry waited", () => {
    subscribe("coder", "local:eng", true);
    subscribe("coder", "local:ops", true);
    store.unsubscribe("coder", "local:ops");
    const watcher = makeWatcher();
    const batched = vi.spyOn(internals(watcher), "runBatchedWake").mockResolvedValue(undefined);
    const solo = vi.spyOn(internals(watcher), "dispatchWake").mockImplementation(() => {});

    internals(watcher).onWakeDue(entry("coder", ["local:eng", "local:ops"]));

    // One batched room left, so it goes back to the per-room path.
    expect(batched).not.toHaveBeenCalled();
    expect(solo).toHaveBeenCalledTimes(1);
  });

  it("refuses to batch at all when rooms.minWakeIntervalMinutes is 0", () => {
    // The hourly ceiling counts one (agent, room) row, and a combined turn is
    // charged to whichever room holds the newest message — so the charged room
    // rotates and nine batched rooms buy 12 x 9 turns an hour. The per-agent
    // floor is the only brake that can bound a turn spanning rooms, so without
    // one the feature is refused rather than silently raising the ceiling.
    subscribe("coder", "local:eng", true);
    subscribe("coder", "local:ops", true);
    const watcher = makeWatcher(["coder"], { minWakeIntervalMinutes: 0 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const batched = vi.spyOn(internals(watcher), "runBatchedWake").mockResolvedValue(undefined);
    const solo = vi.spyOn(internals(watcher), "dispatchWake").mockImplementation(() => {});

    internals(watcher).onWakeDue(entry("coder", ["local:eng", "local:ops"]));

    expect(batched).not.toHaveBeenCalled();
    expect(solo).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("minWakeIntervalMinutes"))).toBe(true);
  });

  it("says why batching is off once per agent, not once per wake", () => {
    subscribe("coder", "local:eng", true);
    subscribe("coder", "local:ops", true);
    const watcher = makeWatcher(["coder"], { minWakeIntervalMinutes: 0 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(internals(watcher), "dispatchWake").mockImplementation(() => {});

    internals(watcher).onWakeDue(entry("coder", ["local:eng", "local:ops"]));
    internals(watcher).onWakeDue(entry("coder", ["local:eng", "local:ops"]));

    expect(warn.mock.calls.filter((c) => String(c[0]).includes("minWakeIntervalMinutes"))).toHaveLength(1);
  });

  it("leaves a scheduled check-in on its own path", async () => {
    // A check-in is a different kind of turn: nobody said anything, and the
    // prompt is about time passing. Folding it into a digest that only runs
    // when something is new would swallow it in the quiet rooms it exists for.
    subscribe("coder", "local:eng", true);
    subscribe("coder", "local:ops", true);
    const watcher = makeWatcher();
    const batchedRun = vi.spyOn(internals(watcher), "runBatchedWake").mockResolvedValue(undefined);
    const checkIn = vi
      .spyOn(watcher as unknown as { runCheckIn: () => Promise<void> }, "runCheckIn")
      .mockResolvedValue(undefined);

    internals(watcher).onWakeDue({
      agent: "coder",
      targets: new Map([
        ["local:eng", new Set(["message" as const])],
        ["local:ops", new Set(["check-in" as const])],
      ]),
    });

    // Only one batchable room is left once the check-in is set aside.
    expect(batchedRun).not.toHaveBeenCalled();
    expect(checkIn).toHaveBeenCalledWith("coder", "local:ops");
  });
});

// --------------------------------------------------------------------------
// Locks
// --------------------------------------------------------------------------

describe("RoomWatcher.runBatchedWake locking", () => {
  it("acquires room queues in sorted order whatever order the rooms arrived in", async () => {
    // There is exactly one sort now, in onRoomTurns, so this test fails if it
    // goes. It used to pass with either of two independent sorts removed, which
    // meant it pinned neither.
    const ops = subscribe("coder", "local:ops", true);
    const eng = subscribe("coder", "local:eng", true);
    const watcher = makeWatcher();
    const acquired: string[] = [];
    vi.spyOn(internals(watcher), "onRoomTurn").mockImplementation(
      (roomRef: string, _key: string, fn: () => Promise<void>) => {
        acquired.push(roomRef);
        return fn();
      },
    );
    vi.spyOn(internals(watcher), "runBatchedTurn").mockResolvedValue(undefined);

    await internals(watcher).runBatchedWake("coder", [ops, eng]);

    expect(acquired).toEqual(["local:eng", "local:ops"]);
  });

  it("lets two agents whose batches overlap in opposite orders both finish", async () => {
    // The deadlock this exists to prevent: one agent taking eng then ops while
    // the other takes ops then eng, each holding a chain the other is waiting
    // on. Unordered acquisition hangs here rather than failing, so the hang is
    // turned into a named failure instead of left to the suite timeout.
    const engA = subscribe("coder", "local:eng", true);
    const opsA = subscribe("coder", "local:ops", true);
    const engB = subscribe("planner", "local:eng", true);
    const opsB = subscribe("planner", "local:ops", true);
    const watcher = makeWatcher(["coder", "planner"]);
    const done: string[] = [];
    vi.spyOn(internals(watcher), "runBatchedTurn").mockImplementation(async (agent: string) => {
      await new Promise((r) => setTimeout(r, 5));
      done.push(agent);
    });

    const both = Promise.all([
      internals(watcher).runBatchedWake("coder", [engA, opsA]),
      internals(watcher).runBatchedWake("planner", [opsB, engB]),
    ]);
    let deadline: ReturnType<typeof setTimeout>;
    await Promise.race([
      both,
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error("room locks deadlocked: neither batch finished")), 1_000);
      }),
    ]).finally(() => clearTimeout(deadline));

    expect(done.sort()).toEqual(["coder", "planner"]);
  });

  it("runs a second batch for the same agent rather than dropping it", async () => {
    // Every nested acquisition used to share one `batch:<agent>` key, so a
    // second batch arriving while the first was between locks hit the queue's
    // dedupe at the first room and vanished whole — no turn, nothing marked
    // pending, and rooms the in-flight batch never covered simply lost.
    const eng = subscribe("coder", "local:eng", true);
    const ops = subscribe("coder", "local:ops", true);
    const ideas = subscribe("coder", "local:ideas", true);
    const watcher = makeWatcher();
    const covered: string[][] = [];
    vi.spyOn(internals(watcher), "runBatchedTurn").mockImplementation(async (_agent: string, subs) => {
      covered.push(subs.map((s) => s.roomRef));
      await new Promise((r) => setTimeout(r, 5));
    });

    await Promise.all([
      internals(watcher).runBatchedWake("coder", [eng, ops]),
      internals(watcher).runBatchedWake("coder", [ideas, ops]),
    ]);

    expect(covered).toHaveLength(2);
    expect(covered.flat()).toContain("local:ideas");
  });
});

// --------------------------------------------------------------------------
// Budget, cursors and events
// --------------------------------------------------------------------------

describe("RoomWatcher batched turn bookkeeping", () => {
  function twoRoomWatcher(): {
    watcher: RoomWatcher;
    subs: RoomSubscription[];
    backlog: Record<string, RoomMessage[]>;
  } {
    const eng = subscribe("coder", "local:eng", true);
    const ops = subscribe("coder", "local:ops", true);
    const watcher = makeWatcher();
    const backlog = {
      "local:eng": [message("eng", { body: "the retry policy needs a decision", createdAt: "2026-08-02 12:00:00" })],
      // Newest, so ops is the primary.
      "local:ops": [message("ops", { body: "disk is at 80%", createdAt: "2026-08-02 12:05:00" })],
    };
    stubBacklog(watcher, backlog);
    return { watcher, subs: [eng, ops], backlog };
  }

  it("charges one wake, against the room with the newest message", async () => {
    const { watcher, subs } = twoRoomWatcher();
    vi.spyOn(watcher as unknown as { runTurn: () => Promise<void> }, "runTurn").mockResolvedValue(undefined);

    await internals(watcher).runBatchedTurn("coder", subs);

    expect(wakesFor("coder", "local:ops")).toBe(1);
    expect(wakesFor("coder", "local:eng")).toBe(0);
  });

  it("runs nothing when no room holds traffic worth waking for", async () => {
    // A poll tick enqueues on its timer whether or not anything happened, so
    // without this a batch would turn any unread chatter into a model turn and
    // batching would raise wake volume rather than lower it.
    const eng = store.subscribe({ agent: "coder", roomRef: "local:eng", wakeOn: "named", batch: true });
    const ops = store.subscribe({ agent: "coder", roomRef: "local:ops", wakeOn: "named", batch: true });
    const watcher = makeWatcher();
    stubBacklog(watcher, {
      "local:eng": [message("eng", { body: "nobody is being addressed here" })],
      "local:ops": [message("ops", { body: "nor here" })],
    });
    const runTurn = vi
      .spyOn(watcher as unknown as { runTurn: () => Promise<void> }, "runTurn")
      .mockResolvedValue(undefined);

    await internals(watcher).runBatchedTurn("coder", [eng, ops]);

    expect(runTurn).not.toHaveBeenCalled();
    expect(wakesFor("coder", "local:eng")).toBe(0);
    // Nothing is lost: the cursors did not move, so this is the context for
    // whatever finally does wake the agent.
    expect(store.getSubscription("coder", "local:eng")?.cursor).toBeNull();
  });

  it("runs when one room deserves a wake, and shows the quiet ones as context", async () => {
    const eng = store.subscribe({ agent: "coder", roomRef: "local:eng", wakeOn: "named", batch: true });
    const ops = store.subscribe({ agent: "coder", roomRef: "local:ops", wakeOn: "named", batch: true });
    const watcher = makeWatcher();
    stubBacklog(watcher, {
      "local:eng": [message("eng", { body: "coder, which retry policy?", to: ["coder"] })],
      "local:ops": [message("ops", { body: "nobody is being addressed here" })],
    });
    let prompt = "";
    runAgentLoopMock.mockImplementation(async (...args: unknown[]) => {
      prompt = args[0] as string;
      return "";
    });

    await internals(watcher).runBatchedTurn("coder", [eng, ops]);

    expect(prompt).toContain("which retry policy?");
    expect(prompt).toContain("nobody is being addressed here");
  });

  it("charges nothing when no room has anything new", async () => {
    const eng = subscribe("coder", "local:eng", true);
    const ops = subscribe("coder", "local:ops", true);
    const watcher = makeWatcher();
    stubBacklog(watcher, {});
    const runTurn = vi
      .spyOn(watcher as unknown as { runTurn: () => Promise<void> }, "runTurn")
      .mockResolvedValue(undefined);

    await internals(watcher).runBatchedTurn("coder", [eng, ops]);

    expect(runTurn).not.toHaveBeenCalled();
    expect(wakesFor("coder", "local:eng")).toBe(0);
    expect(wakesFor("coder", "local:ops")).toBe(0);
  });

  it("stays quiet about a room the transcript budget squeezed out", async () => {
    // The events used to be emitted over every section before the prompt was
    // built, so a room the budget dropped reported room.woke with a full
    // message count while its cursor was deliberately left alone and not one
    // line of it reached the model.
    const eng = subscribe("coder", "local:eng", true);
    const ops = store.subscribe({ agent: "coder", roomRef: "local:ops", wakeOn: "named", batch: true });
    const watcher = makeWatcher();
    stubBacklog(watcher, {
      "local:eng": [message("eng", { body: "x".repeat(40_000), createdAt: "2026-08-02 12:05:00" })],
      "local:ops": [message("ops", { body: "quiet here", createdAt: "2026-08-02 11:00:00" })],
    });
    const woke: string[] = [];
    (watcher as unknown as { runtime: { events: TypedEventBus } }).runtime.events.on("room.woke", (e) =>
      woke.push(e.roomRef),
    );

    await internals(watcher).runBatchedTurn("coder", [eng, ops]);

    expect(woke).toEqual(["local:eng"]);
  });

  it("shows the room that asked even when a louder one would fill the budget", async () => {
    // eng is the sole reason this turn is running, and ops is both newer and
    // enormous. Allocating newest-first alone starves the triggering room: it
    // never appears, keeps its cursor, and is starved again next time — a
    // charged wake in which the room that asked is never read.
    const eng = store.subscribe({ agent: "coder", roomRef: "local:eng", wakeOn: "named", batch: true });
    const ops = store.subscribe({ agent: "coder", roomRef: "local:ops", wakeOn: "named", batch: true });
    const watcher = makeWatcher();
    stubBacklog(watcher, {
      "local:eng": [
        message("eng", { body: "coder, which retry policy?", to: ["coder"], createdAt: "2026-08-02 12:00:00" }),
      ],
      "local:ops": [message("ops", { body: "x".repeat(40_000), createdAt: "2026-08-02 12:05:00" })],
    });
    let prompt = "";
    runAgentLoopMock.mockImplementation(async (...args: unknown[]) => {
      prompt = args[0] as string;
      return "";
    });

    await internals(watcher).runBatchedTurn("coder", [eng, ops]);

    expect(prompt).toContain("which retry policy?");
    expect(store.getSubscription("coder", "local:eng")?.cursor).not.toBeNull();
  });

  /**
   * Guaranteeing the triggering room a slot broke an invariant that used to
   * hold by accident: the newest-message room always won the first slot, so the
   * charged room was always in the prompt. Once a quiet room can be guaranteed
   * ahead of a louder one, the loudest room may not appear at all — and
   * charging it would spend a room's hourly budget on turns that never read it.
   */
  it("charges a room the prompt actually covered, not merely the newest one", async () => {
    const eng = store.subscribe({ agent: "coder", roomRef: "local:eng", wakeOn: "named", batch: true });
    const ops = store.subscribe({ agent: "coder", roomRef: "local:ops", wakeOn: "named", batch: true });
    const watcher = makeWatcher();
    stubBacklog(watcher, {
      // eng triggers the turn, is guaranteed a slot, and its message alone
      // exhausts the budget. ops holds the newest message but nothing of it
      // fits, so it never reaches the prompt — and must not be charged.
      "local:eng": [
        message("eng", {
          body: `coder, which retry policy? ${"x".repeat(40_000)}`,
          to: ["coder"],
          createdAt: "2026-08-02 12:00:00",
        }),
      ],
      "local:ops": [message("ops", { body: "quick note", createdAt: "2026-08-02 12:05:00" })],
    });
    vi.spyOn(watcher as unknown as { runTurn: () => Promise<void> }, "runTurn").mockResolvedValue(undefined);

    await internals(watcher).runBatchedTurn("coder", [eng, ops]);

    expect(wakesFor("coder", "local:eng"), "the room that was read").toBe(1);
    expect(wakesFor("coder", "local:ops"), "never reached the prompt").toBe(0);
  });

  it("clears the agent-turn brake only in the rooms it posted to", async () => {
    // agent_turns belongs to one room's conversation. Clearing it across the
    // batch let a tool call in eng release the anti-chatter brake in ops, where
    // two agents were looping and nothing had been done at all.
    const eng = subscribe("coder", "local:eng", true);
    const ops = subscribe("coder", "local:ops", true);
    const watcher = makeWatcher(["coder", "planner"]);
    stubBacklog(watcher, {
      "local:eng": [message("eng", { body: "which retry policy?", createdAt: "2026-08-02 12:00:00" })],
      "local:ops": [message("ops", { body: "disk is at 80%", createdAt: "2026-08-02 12:05:00" })],
    });
    for (const ref of ["local:eng", "local:ops"]) {
      for (const speaker of ["planner", "coder", "planner"]) store.noteRoomTurn(ref, false, speaker);
    }
    runAgentLoopMock.mockImplementation(async (...args: unknown[]) => {
      const opts = args[1] as {
        onToolCall?: (name: string, args: Record<string, unknown>) => void;
        toolContextExtras: { workingMemory: Map<string, string> };
      };
      opts.onToolCall?.("write", { path: "notes.md" });
      opts.toolContextExtras.workingMemory.set("room:posted:local:eng", "true");
      return "";
    });

    await internals(watcher).runBatchedTurn("coder", [eng, ops]);

    expect(store.agentTurns("local:eng")).toBe(0);
    expect(store.agentTurns("local:ops")).toBe(3);
  });

  it("announces every room it read, not just the one it charged", async () => {
    const { watcher, subs } = twoRoomWatcher();
    vi.spyOn(watcher as unknown as { runTurn: () => Promise<void> }, "runTurn").mockResolvedValue(undefined);
    const woke: string[] = [];
    (watcher as unknown as { runtime: { events: TypedEventBus } }).runtime.events.on("room.woke", (e) =>
      woke.push(e.roomRef),
    );

    await internals(watcher).runBatchedTurn("coder", subs);

    expect(woke.sort()).toEqual(["local:eng", "local:ops"]);
  });

  it("advances the cursor of every room it showed", async () => {
    // Not only the room it charged the wake to: every room in the prompt has
    // now been seen, and re-reading it next time is how an agent answers a
    // question that was settled two wakes ago.
    const { watcher, subs, backlog } = twoRoomWatcher();

    await internals(watcher).runBatchedTurn("coder", subs);

    expect(store.getSubscription("coder", "local:eng")?.cursor).toBe(backlog["local:eng"][0].cursor);
    expect(store.getSubscription("coder", "local:ops")?.cursor).toBe(backlog["local:ops"][0].cursor);
  });

  it("leaves the cursor of a room the budget squeezed out", async () => {
    const eng = subscribe("coder", "local:eng", true);
    // Context rather than a reason to run: nothing here addresses the agent, so
    // it has no guaranteed slot and the budget is free to drop it.
    const ops = store.subscribe({ agent: "coder", roomRef: "local:ops", wakeOn: "named", batch: true });
    const watcher = makeWatcher();
    // One enormous recent message in eng eats the whole transcript budget, so
    // ops never makes it into the prompt and has therefore not been read.
    stubBacklog(watcher, {
      "local:eng": [message("eng", { body: "x".repeat(40_000), createdAt: "2026-08-02 12:05:00" })],
      "local:ops": [message("ops", { body: "quiet here", createdAt: "2026-08-02 11:00:00" })],
    });

    await internals(watcher).runBatchedTurn("coder", [eng, ops]);

    expect(store.getSubscription("coder", "local:eng")?.cursor).not.toBeNull();
    expect(store.getSubscription("coder", "local:ops")?.cursor).toBeNull();
  });

  it("tells the room tool which rooms this turn covers", async () => {
    // `room(action="pass")` with no argument reads this, so an agent declining
    // to speak silences the rooms it was woken for and no others.
    const { watcher, subs } = twoRoomWatcher();
    let seen: string | undefined;
    runAgentLoopMock.mockImplementation(async (...args: unknown[]) => {
      const opts = args[1] as { toolContextExtras: { workingMemory: Map<string, string> } };
      seen = opts.toolContextExtras.workingMemory.get(WAKE_ROOMS_KEY);
      return "";
    });

    await internals(watcher).runBatchedTurn("coder", subs);

    expect(seen?.split(",").sort()).toEqual(["local:eng", "local:ops"]);
  });
});

// --------------------------------------------------------------------------
// The pause switch
// --------------------------------------------------------------------------

describe("RoomWatcher batched turn under the pause switch", () => {
  /** Two rooms: a person waiting in eng, two agents talking to each other in ops. */
  function humanInOneRoom(paused: (kind: "human" | "autonomous") => boolean) {
    const eng = subscribe("coder", "local:eng", true);
    const ops = subscribe("coder", "local:ops", true);
    const watcher = makeWatcher(["coder", "planner"], { paused });
    stubBacklog(watcher, {
      "local:eng": [message("eng", { body: "which retry policy?", speaker: "alex", createdAt: "2026-08-02 12:00:00" })],
      "local:ops": [
        message("ops", {
          body: "I will take the disk alert",
          speaker: "planner",
          authorLabel: "planner",
          authorId: "planner",
          createdAt: "2026-08-02 12:05:00",
        }),
      ],
    });
    return { watcher, subs: [eng, ops] };
  }

  it("drops the agent-only rooms rather than letting one human un-pause them all", async () => {
    // The pause was judged once over every message in the batch, so a person
    // waiting in eng answered "someone is waiting" for ops too — and ops, whose
    // traffic is nothing but two agents talking, was rendered as a section with
    // the agent explicitly invited to post in it. That is the runaway the
    // switch exists to stop, arriving through the feature meant to reduce wakes.
    const { watcher, subs } = humanInOneRoom((kind) => kind === "autonomous");
    let prompt = "";
    runAgentLoopMock.mockImplementation(async (...args: unknown[]) => {
      prompt = args[0] as string;
      return "";
    });

    await internals(watcher).runBatchedTurn("coder", subs);

    expect(prompt).toContain("which retry policy?");
    expect(prompt).not.toContain("I will take the disk alert");
    // Never shown, so never read: the traffic is still there when the pause lifts.
    expect(store.getSubscription("coder", "local:ops")?.cursor).toBeNull();
    expect(store.getSubscription("coder", "local:eng")?.cursor).not.toBeNull();
  });

  it("charges the wake to a room that survived the pause", async () => {
    // ops holds the newest message and would be primary unpaused. A turn that
    // is only about eng must not spend eng's neighbour's budget.
    const { watcher, subs } = humanInOneRoom((kind) => kind === "autonomous");
    // Mocked so the empty reply cannot refund the wake before it is read back.
    vi.spyOn(watcher as unknown as { runTurn: () => Promise<void> }, "runTurn").mockResolvedValue(undefined);

    await internals(watcher).runBatchedTurn("coder", subs);

    expect(wakesFor("coder", "local:eng")).toBe(1);
    expect(wakesFor("coder", "local:ops")).toBe(0);
  });

  it("runs nothing when no room in the batch has a human in it", async () => {
    const eng = subscribe("coder", "local:eng", true);
    const ops = subscribe("coder", "local:ops", true);
    const watcher = makeWatcher(["coder", "planner"], { paused: (kind) => kind === "autonomous" });
    const agentLine = { speaker: "planner", authorLabel: "planner", authorId: "planner" };
    stubBacklog(watcher, {
      "local:eng": [message("eng", { body: "shall I take this?", ...agentLine })],
      "local:ops": [message("ops", { body: "go ahead", ...agentLine })],
    });
    const runTurn = vi
      .spyOn(watcher as unknown as { runTurn: () => Promise<void> }, "runTurn")
      .mockResolvedValue(undefined);

    await internals(watcher).runBatchedTurn("coder", [eng, ops]);

    expect(runTurn).not.toHaveBeenCalled();
    expect(wakesFor("coder", "local:eng")).toBe(0);
    expect(wakesFor("coder", "local:ops")).toBe(0);
  });

  it("runs nothing at all under scope: all, human room or not", async () => {
    const { watcher, subs } = humanInOneRoom(() => true);
    const runTurn = vi
      .spyOn(watcher as unknown as { runTurn: () => Promise<void> }, "runTurn")
      .mockResolvedValue(undefined);

    await internals(watcher).runBatchedTurn("coder", subs);

    expect(runTurn).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// Reply routing
// --------------------------------------------------------------------------

describe("RoomWatcher batched reply routing", () => {
  /**
   * Both rooms really hold the message that woke the agent, so "nothing was
   * posted" is checked as "the room is exactly as it was" rather than as the
   * weaker "the room is empty".
   */
  async function twoRooms(): Promise<{ watcher: RoomWatcher; subs: RoomSubscription[] }> {
    const eng = subscribe("coder", "local:eng", true);
    const ops = subscribe("coder", "local:ops", true);
    await backend.post("eng", { body: "which retry policy?", speaker: "alex" });
    await backend.post("ops", { body: "disk is at 80%", speaker: "alex" });
    const watcher = makeWatcher();
    stubBacklog(watcher, {
      "local:eng": [message("eng", { body: "which retry policy?", createdAt: "2026-08-02 12:00:00" })],
      "local:ops": [message("ops", { body: "disk is at 80%", createdAt: "2026-08-02 12:05:00" })],
    });
    return { watcher, subs: [eng, ops] };
  }

  it("asks which room, once, when the reply is bare text", async () => {
    const { watcher, subs } = await twoRooms();
    runAgentLoopMock.mockResolvedValue("Bounded backoff, capped at five attempts.");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await internals(watcher).runBatchedTurn("coder", subs);

    expect(runAgentLoopMock).toHaveBeenCalledTimes(2);
    const correction = runAgentLoopMock.mock.calls[1][0] as unknown as string;
    expect(correction).toContain("eng");
    expect(correction).toContain("ops");
    expect(correction).toContain('room(action="post"');
    // Still bare after the correction, so it is dropped rather than guessed at.
    expect(warn.mock.calls.some((c) => String(c[0]).includes("naming no room"))).toBe(true);
  });

  it("asks a batched agent for a room when its pass came out as text", async () => {
    // The single-room branch tells the agent to "reply normally with what you
    // want to say" — and a normal reply in a combined turn names no room and is
    // dropped, so the correction round is spent instructing it to fail again.
    const { watcher, subs } = await twoRooms();
    runAgentLoopMock.mockResolvedValue('room(action="pass")');
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await internals(watcher).runBatchedTurn("coder", subs);

    expect(runAgentLoopMock).toHaveBeenCalledTimes(2);
    const correction = runAgentLoopMock.mock.calls[1][0] as unknown as string;
    expect(correction).toContain('room(action="post"');
    expect(correction).toContain("eng");
    expect(correction).toContain("ops");
  });

  it("asks a batched agent for a room when its output was raw tool-call markup", async () => {
    const { watcher, subs } = await twoRooms();
    runAgentLoopMock.mockResolvedValue("<tool_call>\nfunction=room>\n<parameter=body> shipping it </parameter>");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await internals(watcher).runBatchedTurn("coder", subs);

    const correction = runAgentLoopMock.mock.calls[1][0] as unknown as string;
    expect(correction).toContain('room(action="post"');
    expect(correction).toContain("eng");
    expect(correction).toContain("ops");
  });

  it("counts a single covered room as one room", async () => {
    // The budget squeezed ops out, so the turn covers exactly one room and the
    // correction has to say so in English.
    const eng = subscribe("coder", "local:eng", true);
    const ops = store.subscribe({ agent: "coder", roomRef: "local:ops", wakeOn: "named", batch: true });
    const watcher = makeWatcher();
    stubBacklog(watcher, {
      "local:eng": [message("eng", { body: "x".repeat(40_000), createdAt: "2026-08-02 12:05:00" })],
      "local:ops": [message("ops", { body: "quiet here", createdAt: "2026-08-02 11:00:00" })],
    });
    runAgentLoopMock.mockResolvedValue("Bounded backoff, capped at five attempts.");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await internals(watcher).runBatchedTurn("coder", [eng, ops]);

    const correction = runAgentLoopMock.mock.calls[1][0] as unknown as string;
    expect(correction).toContain("covers 1 room:");
    expect(correction).not.toContain("1 rooms");
  });

  it("posts nothing anywhere when the model never names a room", async () => {
    const { watcher, subs } = await twoRooms();
    runAgentLoopMock.mockResolvedValue("I think we should ship it.");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await internals(watcher).runBatchedTurn("coder", subs);

    // The only messages in either room are the ones that woke it.
    const eng = await backend.fetchSince("eng", null, 10);
    const ops = await backend.fetchSince("ops", null, 10);
    expect(eng.map((m) => m.body)).toEqual(["which retry policy?"]);
    expect(ops.map((m) => m.body)).toEqual(["disk is at 80%"]);
  });

  it("says nothing more once the agent posted through the tool", async () => {
    const { watcher, subs } = await twoRooms();
    runAgentLoopMock.mockImplementation(async (...args: unknown[]) => {
      const opts = args[1] as { toolContextExtras?: { workingMemory?: Map<string, string> } };
      opts.toolContextExtras?.workingMemory?.set("room:posted:local:eng", "true");
      return "Posted the answer in eng.";
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await internals(watcher).runBatchedTurn("coder", subs);

    // No correction round, no warning: the agent said its piece.
    expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("naming no room"))).toBe(false);
  });

  it("treats a pass as a decision, not as something to correct", async () => {
    const { watcher, subs } = await twoRooms();
    runAgentLoopMock.mockImplementation(async (...args: unknown[]) => {
      const opts = args[1] as { toolContextExtras?: { workingMemory?: Map<string, string> } };
      for (const ref of ["local:eng", "local:ops"]) {
        opts.toolContextExtras?.workingMemory?.set(`room:passed:${ref}`, "true");
      }
      return "Nothing to add anywhere.";
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await internals(watcher).runBatchedTurn("coder", subs);

    expect(runAgentLoopMock).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("naming no room"))).toBe(false);
  });

  it("refunds the wake when the turn said nothing and did nothing", async () => {
    const { watcher, subs } = await twoRooms();
    runAgentLoopMock.mockImplementation(async (...args: unknown[]) => {
      const opts = args[1] as { toolContextExtras?: { workingMemory?: Map<string, string> } };
      opts.toolContextExtras?.workingMemory?.set("room:passed:local:ops", "true");
      return "";
    });

    await internals(watcher).runBatchedTurn("coder", subs);

    const row = db
      .prepare("SELECT wakes_this_hour AS n FROM room_subscriptions WHERE agent = 'coder' AND room_ref = 'local:ops'")
      .get() as { n: number };
    expect(row.n).toBe(0);
  });
});

// --------------------------------------------------------------------------
// The prompt
// --------------------------------------------------------------------------

describe("selectBatchTranscript", () => {
  const room = (roomRef: string, count: number, startMinute: number, body = "hello") => ({
    roomRef,
    messages: Array.from({ length: count }, (_, i) =>
      message(roomRef, { body, createdAt: `2026-08-02 12:${String(startMinute + i).padStart(2, "0")}:00` }),
    ),
  });

  it("shows at most five messages from any one room", () => {
    const shown = selectBatchTranscript([room("local:eng", 12, 1)]);
    expect(shown.get("local:eng")).toHaveLength(5);
  });

  it("keeps the newest messages and keeps them in order", () => {
    const shown = selectBatchTranscript([
      {
        roomRef: "local:eng",
        messages: [1, 2, 3, 4, 5, 6].map((n) => message("eng", { body: `m${n}`, createdAt: `2026-08-02 12:0${n}:00` })),
      },
    ]);
    expect(shown.get("local:eng")?.map((m) => m.body)).toEqual(["m2", "m3", "m4", "m5", "m6"]);
  });

  it("spends the budget on the room with the newest traffic first", () => {
    // A fixed per-room quota would let the idle room spend its share on last
    // week's chatter and crowd out the room that just asked a question.
    const shown = selectBatchTranscript([room("local:idle", 6, 1), room("local:busy", 6, 20)], {
      budgetTokens: 10,
      cost: () => 4,
    });
    expect(shown.get("local:busy")).toHaveLength(3);
    expect(shown.has("local:idle")).toBe(false);
  });

  it("omits a room it had no budget left for", () => {
    const shown = selectBatchTranscript([room("local:busy", 1, 20), room("local:idle", 1, 1)], {
      budgetTokens: 1,
      cost: () => 5,
    });
    expect([...shown.keys()]).toEqual(["local:busy"]);
  });

  it("always shows the newest message, even one bigger than the whole budget", () => {
    // A prompt that overshoots by one message beats one that omits the message
    // the agent was woken for.
    const shown = selectBatchTranscript([room("local:eng", 1, 1, "x".repeat(40_000))]);
    expect(shown.get("local:eng")).toHaveLength(1);
  });

  it("holds the total down as rooms are added", () => {
    const many = Array.from({ length: 9 }, (_, i) => room(`local:r${i}`, 5, i + 1, "y".repeat(400)));
    const shown = selectBatchTranscript(many);
    const total = [...shown.values()].flat().reduce((n, m) => n + m.body.length, 0);
    // Nine rooms of five 400-character messages is 18,000 characters unbudgeted.
    expect(total).toBeLessThan(6_000);
  });
});

describe("RoomWatcher.buildBatchedPrompt", () => {
  const identities = () =>
    new IdentityResolver({
      agentNames: ["coder", "planner"],
      defaultBackend: "local",
      declared: { alex: { human: { local: "u-alex" } } },
    });

  function section(roomRef: string, name: string, messages: RoomMessage[], over: Record<string, unknown> = {}) {
    return {
      sub: { ...subscribe("coder", roomRef, true), ...over },
      room: { name, purpose: over.purpose as string | undefined },
      messages,
    };
  }

  it("gives each room with new messages a section and omits the rest", () => {
    const watcher = makeWatcher();
    const { prompt } = internals(watcher).buildBatchedPrompt(
      "coder",
      "coder",
      [
        section("local:eng", "eng", [message("eng", { body: "which retry policy?" })]),
        section("local:ideas", "ideas", []),
      ],
      identities(),
    );

    expect(prompt).toContain("## eng");
    // An empty heading is not neutral: it invites an answer to a room that
    // asked nothing.
    expect(prompt).not.toContain("## ideas");
    expect(prompt).toContain("which retry policy?");
  });

  it("names the rooms it is showing and how many", () => {
    const watcher = makeWatcher();
    const { prompt } = internals(watcher).buildBatchedPrompt(
      "coder",
      "coder",
      [
        section("local:eng", "eng", [message("eng", { body: "one" })]),
        section("local:ops", "ops", [message("ops", { body: "two" })]),
      ],
      identities(),
    );

    expect(prompt).toContain("New messages in 2 of the rooms you watch: eng, ops.");
  });

  it("carries each room's purpose and the agent's role in it", () => {
    const watcher = makeWatcher();
    const { prompt } = internals(watcher).buildBatchedPrompt(
      "coder",
      "coder",
      [
        section("local:eng", "eng", [message("eng", { body: "one" })], {
          purpose: "ship the retry work",
          role: "you own the client",
        }),
      ],
      identities(),
    );

    expect(prompt).toContain("Purpose: ship the retry work");
    expect(prompt).toContain("Your role here: you own the client");
  });

  it("states how to post and how to stay quiet, without a single negative", () => {
    const watcher = makeWatcher();
    const { prompt } = internals(watcher).buildBatchedPrompt(
      "coder",
      "coder",
      [
        section("local:eng", "eng", [message("eng", { body: "one" })]),
        section("local:ops", "ops", [message("ops", { body: "two" })]),
      ],
      identities(),
    );

    expect(prompt).toContain('room(action="post", room="<room name>"');
    expect(prompt).toContain('room(action="pass")');
    // Local models mishandle negative directives, so this prompt has none.
    expect(prompt.toLowerCase()).not.toMatch(/\bdo not\b|\bdon't\b|\bnever\b/);
  });

  it("reports what it showed, so cursors can follow it", () => {
    const watcher = makeWatcher();
    const { shown } = internals(watcher).buildBatchedPrompt(
      "coder",
      "coder",
      [section("local:eng", "eng", [message("eng", { body: "one" })]), section("local:ideas", "ideas", [])],
      identities(),
    );

    expect([...shown.keys()]).toEqual(["local:eng"]);
  });

  it("holds a nine-room prompt to something a small model can read", () => {
    const watcher = makeWatcher();
    const sections = Array.from({ length: 9 }, (_, i) =>
      section(
        `local:r${i}`,
        `room-${i}`,
        Array.from({ length: 8 }, (_, j) =>
          message(`r${i}`, { body: "z".repeat(300), createdAt: `2026-08-02 1${i % 10}:0${j}:00` }),
        ),
      ),
    );
    const { prompt } = internals(watcher).buildBatchedPrompt("coder", "coder", sections, identities());

    // 72 messages of 300 characters is 21,600 unbudgeted.
    expect(prompt.length).toBeLessThan(8_000);
  });

  it("charges each room's heading and purpose against the transcript budget", () => {
    // The framing was built after the allocation and never charged, so the one
    // hard total this design turns on was a total over only part of the prompt
    // — and purposes are free-text config, which makes the uncharged part
    // unbounded and proportional to the number of rooms.
    const watcher = makeWatcher();
    const sections = Array.from({ length: 9 }, (_, i) =>
      section(`local:r${i}`, `room-${i}`, [message(`r${i}`, { body: "one", createdAt: `2026-08-02 12:0${i}:00` })], {
        purpose: "p".repeat(2_000),
      }),
    );

    const { prompt, shown } = internals(watcher).buildBatchedPrompt("coder", "coder", sections, identities());

    // Nine 2,000-character purposes is 18,000 characters of prompt outside any
    // budget at all.
    expect(shown.size).toBeLessThan(9);
    expect(prompt.length).toBeLessThan(9_000);
  });

  it("shows a room the newest-first pass would have skipped, when asked to", () => {
    const watcher = makeWatcher();
    const { shown } = internals(watcher).buildBatchedPrompt(
      "coder",
      "coder",
      [
        section("local:eng", "eng", [message("eng", { body: "coder?", createdAt: "2026-08-02 11:00:00" })]),
        section("local:ops", "ops", [message("ops", { body: "x".repeat(40_000), createdAt: "2026-08-02 12:00:00" })]),
      ],
      identities(),
      ["local:eng"],
    );

    expect([...shown.keys()].sort()).toEqual(["local:eng", "local:ops"]);
  });

  it("condenses the agent's own words rather than quoting them back in full", () => {
    const watcher = makeWatcher();
    const { prompt } = internals(watcher).buildBatchedPrompt(
      "coder",
      "coder",
      [
        section("local:eng", "eng", [
          message("eng", { speaker: "coder", authorLabel: "coder", body: `Here is the plan. ${"x".repeat(2000)}` }),
        ]),
      ],
      identities(),
    );

    expect(prompt).toContain("Here is the plan.");
    expect(prompt).not.toContain("x".repeat(2000));
  });
});
