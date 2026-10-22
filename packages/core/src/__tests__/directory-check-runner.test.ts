/**
 * Commitment checks that wake their owner: the runner's look for due checks,
 * the claim that keeps a slow turn from running twice, what the waker's
 * pause and hourly ceiling do to a check, the note and backoff after a check
 * that changed nothing, changes that make a check due (a burst is one wake),
 * the commitments that never wake, a reload, and the guard that makes every
 * check's turn ask first.
 *
 * The runner is driven with an injected clock against a real world-state
 * service whose `state.changed` reaches it as the plugin wires it; the wake
 * is a stand-in that records what it was asked and can act as the agent.
 * The plugin-level tests load the plugin the way the CLI does, and the guard
 * is checked through a real runtime's agent loop.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearContextSlots } from "../agent/context-slots.js";
import { runAgentLoop } from "../agent/loop.js";
import type { AgentConfig } from "../config.js";
import { initDatabase } from "../db/schema.js";
import { TypedEventBus } from "../events.js";
import { createTools } from "../factories.js";
import { HttpRouteRegistry } from "../http/registry.js";
import { createPluginContext } from "../plugin-context.js";
import * as directoryPlugin from "../plugins/directory.js";
import {
  ASKS_FIRST,
  asksFirst,
  BACKSTOP_MS,
  CEILING_DELAY_MS,
  CHECKER,
  Checker,
  type CheckerOptions,
  checkPrompt,
  LEASE_MS,
  NO_CHANGE,
  notOpen,
  rederive,
  withEvents,
} from "../plugins/directory-checks.js";
import { COMMITMENT_TYPE, DIRECTORY_TYPES, Directory } from "../plugins/directory-records.js";
import { type LoadedPlugin, loadPlugins } from "../plugins.js";
import type { AIProvider, ChatResponse } from "../providers/interface.js";
import { RoomStore } from "../rooms/store.js";
import { AgentRuntime } from "../runtime.js";
import { stateTypeRegistry } from "../state/registry.js";
import { type StateCaller, StateService } from "../state/service.js";
import type { StateChange, StateRecord, StateTypeDef } from "../state/types.js";
import type { Tool } from "../tools/interface.js";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const PERSON: StateCaller = { actor: { kind: "user", name: "owner" }, source: { surface: "web" } };
/** As the commitment tool writes for an agent. */
const forAgent = (agent: string): StateCaller => ({
  actor: { kind: "plugin", name: "directory" },
  source: { tool: "commitment", onBehalfOf: agent },
});
const START = new Date("2026-10-22T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** A type only the planner may read, and two anyone may. */
const PLAN: StateTypeDef = {
  name: "plan",
  description: "Plans.",
  scope: "global",
  access: { read: ["planner", "user"] },
};
const NOTE: StateTypeDef = { name: "note", description: "Notes.", scope: "global" };
const TRIP: StateTypeDef = { name: "trip", description: "Trips.", scope: "global" };

let db: ReturnType<typeof initDatabase>;
let events: TypedEventBus;
let service: StateService;
let store: RoomStore;
let clock: number;
let directory: Directory;
let woken: Array<{ agent: string; prompt: string; sessionKey: string; wake: { kind: string; ref?: string } }>;
let act: (agent: string, id: string) => Promise<"ran" | "paused" | "at-ceiling" | "gone">;
let refusal: CheckerOptions["refusal"];
let tools: Record<string, boolean>;
let allPaused: boolean;
let checkers: Checker[];
let typeDisposers: Array<() => void>;

/** A checker; `lock` stands for another runtime's, which doesn't wait for this one's. */
function checker(lock?: object): Checker {
  const c = new Checker({
    directory,
    wake: async (agent, opts) => {
      woken.push({ agent, ...opts });
      return act(agent, opts.wake.ref ?? "");
    },
    refusal: (agent, where) => refusal(agent, where),
    paused: () => allPaused,
    canUpdate: (agent) => tools[agent] !== false,
    ...(lock ? { lock } : {}),
    log: () => {},
    warn: () => {},
  });
  checkers.push(c);
  return c;
}

/** Start a checker and wire it to the bus, as the plugin does. */
async function started(lock?: object): Promise<Checker> {
  const c = checker(lock);
  events.on("state.changed", (change) => c.onChange(change));
  await c.start();
  await c.idle();
  return c;
}

async function commitment(id: string, data: Record<string, unknown>, scope = "global"): Promise<StateRecord> {
  return service.put(
    PERSON,
    {
      type: COMMITMENT_TYPE,
      id,
      scope,
      data: { owner: "planner", goal: "Watch hotel prices", status: "open", autonomy: "suggest", ...data },
    },
    0,
  );
}

const read = async (id: string) => (await service.get(PERSON, { type: COMMITMENT_TYPE, id })) as StateRecord;
const texts = (r: StateRecord) => ((r.data.updates ?? []) as Array<{ text: string }>).map((u) => u.text);

/** Let the clock reach `ms` and look once, as the interval would. */
async function at(c: Checker, ms: number): Promise<void> {
  clock = ms;
  c.tick();
  await c.idle();
}

/** Let listeners that read and write after a change finish. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  db = initDatabase(":memory:");
  events = new TypedEventBus();
  service = new StateService({
    getConfig: () => ({ state: { backend: "sqlite", types: [PLAN, NOTE, TRIP] } }),
    db,
    events,
  });
  typeDisposers = DIRECTORY_TYPES.map((def) => stateTypeRegistry.register(def.name, { ...def }));
  store = new RoomStore(db);
  clock = START.getTime();
  directory = new Directory({
    getService: () => service,
    agents: () => ["planner", "writer", "trip-planner"],
    describe: () => undefined,
    now: () => new Date(clock),
    timeZone: () => "Europe/Lisbon",
    rooms: () => ({
      list: () =>
        store.listRooms().map((r) => ({ ref: `${r.ref.backend}:${r.ref.id}`, name: r.name, archived: false })),
      find: (n) => {
        const r = store.resolve(n);
        return r ? { ref: `${r.ref.backend}:${r.ref.id}`, name: r.name, archived: !!r.archivedAt } : undefined;
      },
      subscribers: (ref) => store.listSubscriptionsForRoom(ref).map((s) => s.agent),
    }),
  });
  woken = [];
  act = async () => "ran";
  refusal = () => undefined;
  tools = {};
  allPaused = false;
  checkers = [];
});

/** Wakes a test holds open, let go after it whatever it found, so a failed test can't hold the next one up. */
const held: Array<() => void> = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const c of checkers) await c.stop();
  for (const let_go of held.splice(0)) let_go();
  await checkers[0]?.idle();
  for (const dispose of typeDisposers) dispose();
  clearContextSlots();
  vi.restoreAllMocks();
});

describe("a due check", () => {
  it("is claimed before the turn, so a look during a slow turn doesn't wake it again", async () => {
    await commitment("planner-watch", { nextCheck: "in 2 minutes", checkAt: iso(START.getTime() + 2 * MINUTE) });
    const c = await started();
    let release!: () => void;
    let during: StateRecord | undefined;
    act = async (_agent, id) => {
      during = await read(id);
      await new Promise<void>((resolve) => {
        release = resolve;
        held.push(resolve);
      });
      return "ran";
    };
    clock = START.getTime() + 2 * MINUTE;
    c.tick();
    await vi.waitFor(() => expect(during).toBeDefined());
    // Claimed: its time moved a lease on and when it was checked set, before the agent did anything.
    expect(during?.data.checkAt).toBe(iso(clock + LEASE_MS));
    expect(during?.data.checkedAt).toBe(iso(clock));
    // Another look, and another checker, while the turn runs: nothing more.
    c.tick();
    const other = checker();
    other.tick();
    release();
    await c.idle();
    expect(woken).toHaveLength(1);
    expect(woken[0]).toMatchObject({
      agent: "planner",
      sessionKey: "commitment:planner-watch",
      wake: { kind: "commitment", ref: "planner-watch" },
    });
  });

  it("isn't woken before its time", async () => {
    await commitment("planner-watch", { checkAt: iso(START.getTime() + 2 * MINUTE) });
    const c = await started();
    await at(c, START.getTime() + MINUTE);
    expect(woken).toHaveLength(0);
    await at(c, START.getTime() + 2 * MINUTE);
    expect(woken).toHaveLength(1);
  });

  it("stays due while agents are paused, and nothing is written", async () => {
    const before = await commitment("planner-watch", { checkAt: iso(START.getTime()) });
    refusal = () => ({ outcome: "paused", why: "agents are paused" });
    const c = await started();
    await at(c, START.getTime() + MINUTE);
    expect(woken).toHaveLength(0);
    const after = await read("planner-watch");
    expect(after.version).toBe(before.version);
    expect(after.data.checkAt).toBe(iso(START.getTime()));
    // Unpaused, it runs at the next look.
    refusal = () => undefined;
    await at(c, START.getTime() + 2 * MINUTE);
    expect(woken).toHaveLength(1);
  });

  it("comes round five minutes on at the agent's hourly wake ceiling", async () => {
    await commitment("planner-watch", { checkAt: iso(START.getTime() + MINUTE) });
    refusal = () => ({ outcome: "at-ceiling", why: "it's at its wake ceiling: 12 wakes in the last hour" });
    const c = await started();
    await at(c, START.getTime() + MINUTE);
    expect(woken).toHaveLength(0);
    expect((await read("planner-watch")).data.checkAt).toBe(iso(START.getTime() + MINUTE + CEILING_DELAY_MS));
  });

  it("at the ceiling waits for the hour to have room, when that's later than five minutes", async () => {
    await commitment("planner-watch", { checkAt: iso(START.getTime()) });
    refusal = () => ({
      outcome: "at-ceiling",
      why: "it's at its wake ceiling: 12 wakes in the last hour",
      until: START.getTime() + 40 * MINUTE,
    });
    await started();
    expect(woken).toHaveLength(0);
    expect((await read("planner-watch")).data.checkAt).toBe(iso(START.getTime() + 40 * MINUTE));
  });

  it("passes over an agent that's switched off, so its checks don't hold up everyone else's", async () => {
    // More of the oldest due checks than one look reads, all for an agent paused on the Agents page.
    for (let i = 0; i < 20; i++) {
      await commitment(`writer-${i}`, { owner: "writer", checkAt: iso(START.getTime() - DAY + i * MINUTE) });
    }
    await commitment("planner-watch", { checkAt: iso(START.getTime()) });
    refusal = (agent) =>
      agent === "writer" ? { outcome: "paused", why: "it's switched off or paused on the Agents page" } : undefined;
    await started();
    expect(woken.map((w) => w.agent)).toEqual(["planner"]);
    // The writer's stay due and untouched, for when it's switched on again.
    expect((await read("writer-0")).version).toBe(1);
    expect((await read("writer-0")).data.checkAt).toBe(iso(START.getTime() - DAY));
  });

  it("reads nothing while agents are paused for everyone, and runs at the first look after", async () => {
    await commitment("planner-watch", { checkAt: iso(START.getTime()) });
    allPaused = true;
    const query = vi.spyOn(service, "query");
    const c = await started();
    await at(c, START.getTime() + MINUTE);
    expect(query.mock.calls.filter(([caller]) => caller === CHECKER)).toEqual([]);
    expect(woken).toHaveLength(0);
    allPaused = false;
    await at(c, START.getTime() + 2 * MINUTE);
    expect(woken).toHaveLength(1);
  });

  it("comes round again a lease on when its turn never got to its end", async () => {
    await commitment("planner-watch", { nextCheck: "in 2 minutes", checkAt: iso(START.getTime()) });
    // The process stops in the middle of the turn: the claim landed, and nothing after it ever will.
    act = () => new Promise<"ran">((resolve) => held.push(() => resolve("ran")));
    await checker().start();
    await vi.waitFor(() => expect(woken).toHaveLength(1));
    expect((await read("planner-watch")).data.checkAt).toBe(iso(START.getTime() + LEASE_MS));
    // A new process on the same store, which knows nothing of the first: not due again until the lease runs out.
    act = async () => "ran";
    const next = await started({});
    await at(next, START.getTime() + LEASE_MS - MINUTE);
    expect(woken).toHaveLength(1);
    await at(next, START.getTime() + LEASE_MS);
    expect(woken).toHaveLength(2);
    const r = await read("planner-watch");
    expect(texts(r)[0]).toBe(NO_CHANGE);
    expect(r.data.checkAt).toBe(iso(START.getTime() + LEASE_MS + DAY));
  });

  it("is put back as it was when the waker turns it away after the claim", async () => {
    await commitment("planner-watch", { checkAt: iso(START.getTime()), checkEvents: ["plan/lisbon updated"] });
    act = async () => "paused";
    const c = await started();
    await at(c, START.getTime() + MINUTE);
    let r = await read("planner-watch");
    expect(r.data.checkAt).toBe(iso(START.getTime()));
    expect(r.data.checkedAt).toBeUndefined();
    expect(r.data.checkEvents).toEqual(["plan/lisbon updated"]);

    act = async () => "at-ceiling";
    await at(c, START.getTime() + 2 * MINUTE);
    r = await read("planner-watch");
    expect(r.data.checkAt).toBe(iso(START.getTime() + 2 * MINUTE + CEILING_DELAY_MS));
    expect(r.data.checkEvents).toEqual(["plan/lisbon updated"]);
  });

  it("that changes nothing is said so, and comes round 1, 2, 4, then 7 days on", async () => {
    await commitment("planner-watch", {
      nextCheck: "in 2 minutes",
      checkAt: iso(START.getTime()),
      updates: [{ at: iso(START.getTime() - DAY), text: "Opened." }],
    });
    const c = await started();
    let now = START.getTime();
    const gaps: number[] = [];
    for (let i = 0; i < 5; i++) {
      await at(c, now);
      const r = await read("planner-watch");
      const next = Date.parse(String(r.data.checkAt));
      gaps.push((next - now) / DAY);
      now = next;
    }
    expect(woken).toHaveLength(5);
    expect(gaps).toEqual([1, 2, 4, 7, 7]);
    expect(texts(await read("planner-watch"))).toEqual([
      NO_CHANGE,
      NO_CHANGE,
      NO_CHANGE,
      NO_CHANGE,
      NO_CHANGE,
      "Opened.",
    ]);
  });

  it("whose agent set a new check keeps it, with no note written for it", async () => {
    await commitment("planner-watch", { checkAt: iso(START.getTime()) });
    act = async (agent, id) => {
      const r = await read(id);
      await service.patch(
        forAgent(agent),
        { type: COMMITMENT_TYPE, id },
        {
          nextCheck: "Friday 9am",
          checkAt: "2026-10-23T08:00:00.000Z",
          updates: [{ at: iso(clock), text: "Two hotels dropped their price." }, ...((r.data.updates as []) ?? [])],
        },
        r.version,
      );
      return "ran";
    };
    const c = await started();
    await at(c, START.getTime() + MINUTE);
    const r = await read("planner-watch");
    expect(r.data.checkAt).toBe("2026-10-23T08:00:00.000Z");
    expect(texts(r)).toEqual(["Two hotels dropped their price."]);
  });

  it("whose agent wrote an update but set no check comes round a day on, with no note", async () => {
    await commitment("planner-watch", { checkAt: iso(START.getTime()) });
    act = async (agent, id) => {
      const r = await read(id);
      await service.patch(
        forAgent(agent),
        { type: COMMITMENT_TYPE, id },
        { updates: [{ at: iso(clock), text: "Asked." }] },
        r.version,
      );
      return "ran";
    };
    const c = await started();
    await at(c, START.getTime());
    const r = await read("planner-watch");
    expect(texts(r)).toEqual(["Asked."]);
    expect(r.data.checkAt).toBe(iso(START.getTime() + DAY));
  });

  it("whose agent left a note for its check keeps it a note, as the tool told it, and nothing wakes it", async () => {
    await commitment("planner-watch", { nextCheck: "in 2 minutes", checkAt: iso(START.getTime()) });
    act = async (agent, id) => {
      const r = await read(id);
      // As the tool writes a note: the text, and no time or change beside it.
      await service.patch(
        forAgent(agent),
        { type: COMMITMENT_TYPE, id },
        {
          nextCheck: "after Sam replies",
          checkAt: null,
          checkOn: null,
          updates: [{ at: iso(clock), text: "Asked Sam." }],
        },
        r.version,
      );
      return "ran";
    };
    const c = await started();
    expect(woken).toHaveLength(1);
    const r = await read("planner-watch");
    expect(r.data.nextCheck).toBe("after Sam replies");
    expect(r.data.checkAt).toBeUndefined();
    await at(c, START.getTime() + 30 * DAY);
    expect(woken).toHaveLength(1);
  });

  it("marks the note it writes for a check that changed nothing, so the same words from the agent still count", async () => {
    await commitment("planner-watch", {
      checkAt: iso(START.getTime()),
      // The agent wrote the very words itself, a day ago: that was an update, not a check.
      updates: [{ at: iso(START.getTime() - DAY), text: NO_CHANGE }],
    });
    const c = await started();
    const r = await read("planner-watch");
    expect(r.data.updates).toEqual([
      { at: iso(START.getTime()), text: NO_CHANGE, kind: "check" },
      { at: iso(START.getTime() - DAY), text: NO_CHANGE },
    ]);
    // One check that changed nothing so far, so the first step of the backoff.
    expect(r.data.checkAt).toBe(iso(START.getTime() + DAY));
    await c.stop();
  });

  it("never wakes for a finished, dropped or archived commitment", async () => {
    await commitment("planner-done", { status: "done", checkAt: iso(START.getTime()) });
    await commitment("planner-dropped", { status: "dropped", checkAt: iso(START.getTime()) });
    await commitment("planner-archived", { checkAt: iso(START.getTime()) });
    await service.archive(PERSON, { type: COMMITMENT_TYPE, id: "planner-archived" }, "done with it");
    await commitment("planner-waiting", { status: "waiting", checkAt: iso(START.getTime()) });
    const c = await started();
    await at(c, START.getTime() + MINUTE);
    expect(woken.map((w) => w.wake.ref)).toEqual(["planner-waiting"]);
  });

  it("isn't woken for an agent with no commitment tool, which couldn't write down what it found", async () => {
    await commitment("writer-watch", { owner: "writer", checkAt: iso(START.getTime()) });
    tools.writer = false;
    const c = await started();
    await at(c, START.getTime());
    expect(woken).toHaveLength(0);
    expect((await read("writer-watch")).data.checkAt).toBe(iso(START.getTime() + DAY));
  });

  it("of a room with no lead says so on the commitment", async () => {
    store.upsertRoom({ ref: { backend: "local", id: "garden" }, name: "garden" }, "alex");
    await commitment("room-garden-water", {
      owner: "room:local:garden",
      room: "local:garden",
      checkAt: iso(START.getTime()),
    });
    const c = await started();
    await at(c, START.getTime());
    expect(woken).toHaveLength(0);
    const r = await read("room-garden-water");
    expect(r.data.checkAt).toBeUndefined();
    expect(texts(r)[0]).toBe("Couldn't check on it: the garden room has no lead to wake.");
  });

  it("asks in a small prompt: the commitment, the newest updates, why now, what it may do, and what to do", async () => {
    const record = await commitment("planner-watch", {
      goal: "Watch hotel prices",
      doneWhen: "Three under budget",
      nextStep: "Compare Friday's list",
      nextCheck: "Friday 9am",
      checkAt: "2026-10-23T08:00:00.000Z",
      progress: { value: 2, max: 3 },
      updates: [
        { at: "2026-10-21T09:00:00.000Z", text: "Two shortlisted." },
        { at: "2026-10-20T09:00:00.000Z", text: "Found five." },
        { at: "2026-10-19T09:00:00.000Z", text: "Asked for dates." },
        { at: "2026-10-18T09:00:00.000Z", text: "Opened." },
      ],
    });
    const prompt = checkPrompt(record, { timeZone: "Europe/Lisbon", whose: "your" });
    expect(prompt).toBe(
      [
        'Time to check on your commitment planner-watch "Watch hotel prices" (open, 2/3).',
        "Done when: Three under budget",
        "Next step: Compare Friday's list",
        "Latest:",
        "- 2026-10-21: Two shortlisted.",
        "- 2026-10-20: Found five.",
        "- 2026-10-19: Asked for dates.",
        'Why now: its check was due Fri, Oct 23, 09:00 ("Friday 9am").',
        "It asks first: update your commitments and docs and read records and files, but put anything that would change something else in nextStep and set the commitment waiting on a person.",
        "Do the next step, then update the commitment with progress and a new check (commitment update, id planner-watch).",
      ].join("\n"),
    );
    // About 120 tokens, at four characters a token.
    expect(prompt.length).toBeLessThan(700);
    const told = checkPrompt(
      { ...record, data: { ...record.data, autonomy: "tell" } },
      { timeZone: "UTC", whose: "your" },
    );
    expect(told).toContain("It's marked tell, but for now every check asks first");
  });
});

describe("a check on a change", () => {
  /** A commitment watching `on`, and the record `<type>/lisbon` for it to watch. */
  async function watching(on: Record<string, unknown>, owner = "planner", type = "plan", scope = "global") {
    await service.put(PERSON, { type, id: "lisbon", scope: "global", data: { status: "draft" } }, 0);
    await commitment(
      `${owner}-watch`,
      { owner, nextCheck: `when ${type}/lisbon changes`, checkOn: on, checkAt: iso(START.getTime() + BACKSTOP_MS) },
      scope,
    );
  }

  const touch = async (caller: StateCaller, data: Record<string, unknown>, type = "plan") => {
    const record = await service.get(PERSON, { type, id: "lisbon" });
    await service.patch(caller, { type, id: "lisbon" }, data, record?.version);
  };

  it("makes a burst of changes one wake, which says what changed", async () => {
    // The gathering window is a timer: held still, so the burst ends when the test says.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // A record anyone may read, so the lines can say what changed in it.
    await watching({ type: "trip", id: "lisbon" }, "planner", "trip");
    const c = await started();
    expect(c.watching()).toEqual(["planner-watch"]);
    // A burst comes over a while, not all at once: each change is seen before the next.
    await touch(PERSON, { status: "final" }, "trip");
    await settle();
    await touch(PERSON, { budget: 900 }, "trip");
    await settle();
    await touch(PERSON, { budget: 950 }, "trip");
    await settle();
    expect(woken).toHaveLength(0);
    await c.flush();
    await c.idle();
    // And at the next look too: the burst was all one check.
    await at(c, clock + MINUTE);
    expect(woken).toHaveLength(1);
    const prompt = woken[0].prompt;
    expect(prompt).toContain("Why now: what it watches changed.");
    expect(prompt).toContain(
      [
        "- trip/lisbon updated by a person (web): budget: 900 → 950",
        "- trip/lisbon updated by a person (web): budget set to 900",
        "- trip/lisbon updated by a person (web): status: draft → final",
      ].join("\n"),
    );
    // The lines went with the wake; after a turn that changed nothing, the backstop comes round again.
    const r = await read("planner-watch");
    expect(r.data.checkEvents).toBeUndefined();
    expect(r.data.checkAt).toBe(iso(START.getTime() + BACKSTOP_MS));
    expect(texts(r)[0]).toBe(NO_CHANGE);
  });

  it("doesn't wake an agent for its own change", async () => {
    await watching({ type: "plan", id: "lisbon" });
    const c = await started();
    await touch({ actor: { kind: "agent", name: "planner" } }, { status: "final" });
    await touch(forAgent("planner"), { status: "booked" });
    await settle();
    await c.flush();
    await c.idle();
    expect(woken).toHaveLength(0);
  });

  it("doesn't wake an agent for a record it can't read", async () => {
    // A person set the writer to watch plans by hand; the writer can't read them.
    await watching({ type: "plan" }, "writer");
    await service.put(PERSON, { type: "note", id: "private", scope: "agent:planner", data: { text: "mine" } }, 0);
    await commitment("writer-notes", {
      owner: "writer",
      checkOn: { type: "note" },
      checkAt: iso(START.getTime() + DAY),
    });
    const c = await started();
    await touch(PERSON, { status: "final" });
    const note = await service.get(PERSON, { type: "note", id: "private" });
    await service.patch(PERSON, { type: "note", id: "private" }, { text: "still mine" }, note?.version);
    await settle();
    await c.flush();
    await c.idle();
    expect(woken).toHaveLength(0);
  });

  it("matches only the fields it names", async () => {
    await watching({ type: "plan", where: { status: "final" } });
    const c = await started();
    await touch(PERSON, { budget: 900 });
    await settle();
    await c.flush();
    await c.idle();
    expect(woken).toHaveLength(0);
    await touch(PERSON, { status: "final" });
    await settle();
    await c.flush();
    await c.idle();
    expect(woken).toHaveLength(1);
  });

  it("stops watching once its commitment is finished", async () => {
    await watching({ type: "plan", id: "lisbon" });
    const c = await started();
    const r = await read("planner-watch");
    await service.patch(PERSON, { type: COMMITMENT_TYPE, id: "planner-watch" }, { status: "done" }, r.version);
    expect(c.watching()).toEqual([]);
    await touch(PERSON, { status: "final" });
    await settle();
    await c.flush();
    await c.idle();
    expect(woken).toHaveLength(0);
  });

  it("tells what changed only where everyone who can read the commitment could read it", async () => {
    // A shared commitment watches a plan, which only the planner may read; every agent reads the commitment.
    await watching({ type: "plan", id: "lisbon" });
    allPaused = true;
    const c = await started();
    await touch(PERSON, { budget: 4321 });
    await settle();
    await c.flush();
    expect((await read("planner-watch")).data.checkEvents).toEqual(["plan/lisbon changed; read it to see how"]);
    const writer: StateCaller = { actor: { kind: "agent", name: "writer" } };
    const seen = await service.get(writer, { type: COMMITMENT_TYPE, id: "planner-watch" });
    expect(seen).toBeDefined();
    expect(JSON.stringify(seen?.data)).not.toContain("4321");
    // The planner, which can read the plan, is told to.
    allPaused = false;
    await at(c, clock);
    expect(woken[0].prompt).toContain("- plan/lisbon changed; read it to see how");
  });

  it("names no more than the commitment does for a record kept narrower than it, and all of it in its own scope", async () => {
    store.upsertRoom({ ref: { backend: "local", id: "garden" }, name: "garden" }, "alex");
    store.subscribe({ agent: "planner", roomRef: "local:garden", source: "config" });
    await service.put(PERSON, { type: "note", id: "gate", scope: "room:local:garden", data: { text: "old" } }, 0);
    // A shared commitment and one in the room, both watching any note.
    const on = { nextCheck: "when note changes", checkOn: { type: "note" }, checkAt: iso(START.getTime() + DAY) };
    await commitment("planner-notes", on);
    await commitment("planner-garden", on, "room:local:garden");
    allPaused = true;
    const c = await started();
    const note = await service.get(PERSON, { type: "note", id: "gate" });
    await service.patch(PERSON, { type: "note", id: "gate" }, { text: "code 4321" }, note?.version);
    await settle();
    await c.flush();
    expect((await read("planner-notes")).data.checkEvents).toEqual([
      "a note it watches changed; look it up to see which",
    ]);
    expect((await read("planner-garden")).data.checkEvents).toEqual([
      "note/gate updated by a person (web): text: old → code 4321",
    ]);
  });

  it("keeps the five newest lines, the last counting the rest", () => {
    expect(withEvents(["a", "b"], ["c"])).toEqual(["a", "b", "c"]);
    expect(withEvents(["a", "b", "c"], ["d", "e", "f"])).toEqual(["a", "b", "c", "d", "…and 2 more"]);
    expect(withEvents(["z"], ["a", "b", "c", "d", "…and 2 more"])).toEqual(["z", "a", "b", "c", "…and 3 more"]);
  });
});

describe("a person's edit, read again", () => {
  const ref = { type: COMMITMENT_TYPE, id: "planner-watch" };

  it("is read past a write that crossed it, and left alone once its text has changed since", async () => {
    const r = await commitment("planner-watch", { nextCheck: "in 2 days", checkAt: iso(START.getTime() + 2 * DAY) });
    const changes: StateChange[] = [];
    const sub = events.on("state.changed", (change) => void changes.push(change));
    await service.patch(PERSON, ref, { nextCheck: "in 1 hour" }, r.version);
    // The checker moves the check on before the person's edit is read again.
    await service.patch(CHECKER, ref, { checkAt: iso(START.getTime() + 3 * DAY) }, r.version + 1);
    await rederive(directory, changes[0]);
    expect((await read("planner-watch")).data.checkAt).toBe(iso(START.getTime() + HOUR));

    // Two edits, the first read after the second landed: the second's own reading is what counts.
    await service.patch(PERSON, ref, { nextCheck: "in 5 hours" }, (await read("planner-watch")).version);
    const first = changes.at(-1) as StateChange;
    await service.patch(PERSON, ref, { nextCheck: "in 3 hours" }, (await read("planner-watch")).version);
    const version = (await read("planner-watch")).version;
    sub.dispose();
    expect(await rederive(directory, first)).toBeUndefined();
    expect((await read("planner-watch")).version).toBe(version);
  });
});

describe("a commitment written before checks were read", () => {
  it("is read once when the checker starts, when it reads the same whenever it's read", async () => {
    await commitment("planner-dated", { nextCheck: "2026-10-28" });
    await commitment("planner-watch", { nextCheck: "when trip/lisbon changes" });
    await commitment("planner-relative", { nextCheck: "in 2 days" });
    await commitment("planner-done", { status: "done", nextCheck: "2026-10-28" });
    const c = await started();
    // 09:00 in Lisbon, which is back on UTC by then.
    expect((await read("planner-dated")).data.checkAt).toBe("2026-10-28T09:00:00.000Z");
    expect((await read("planner-watch")).data.checkOn).toEqual({ type: "trip", id: "lisbon" });
    expect(c.watching()).toEqual(["planner-watch"]);
    // What "in 2 days" meant when it was written can't be told now, so it's left as it was.
    expect((await read("planner-relative")).version).toBe(1);
    expect((await read("planner-done")).version).toBe(1);
    // Once: a second start writes nothing more.
    const version = (await read("planner-dated")).version;
    await c.stop();
    await started();
    expect((await read("planner-dated")).version).toBe(version);
  });
});

describe("the suggest guard", () => {
  const wake = { kind: "commitment", ref: "planner-watch" };

  it("refuses a check's call that writes, can't be undone, or says nothing of what it does", () => {
    expect(asksFirst({ tool: "exec", effect: "write", effectDeclared: true, wake })).toBe(ASKS_FIRST);
    expect(asksFirst({ tool: "coding_agent", effect: "irreversible", effectDeclared: true, wake })).toBe(ASKS_FIRST);
    // A tool that says nothing may only read, so it isn't sent to a person: it's said to be closed to a check.
    expect(asksFirst({ tool: "web_fetch", effect: "read", effectDeclared: false, wake })).toBe(notOpen("web_fetch"));
  });

  it("lets through its reads and the agent's own directory tools", () => {
    expect(asksFirst({ tool: "exec", effect: "read", effectDeclared: true, wake })).toBeUndefined();
    for (const tool of ["commitment", "writeup", "directory"]) {
      expect(asksFirst({ tool, effect: "write", effectDeclared: true, wake })).toBeUndefined();
    }
  });

  it("leaves every other turn alone, a person's chat included", () => {
    expect(asksFirst({ tool: "exec", effect: "write", effectDeclared: true })).toBeUndefined();
    expect(
      asksFirst({ tool: "exec", effect: "write", effectDeclared: true, wake: { kind: "upkeep" } }),
    ).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// The plugin, loaded as the CLI loads it
// --------------------------------------------------------------------------

describe("the plugin", () => {
  let routes: HttpRouteRegistry;
  let loaded: LoadedPlugin[];
  let wakeAgent: ReturnType<typeof vi.fn>;
  let runtime: AgentRuntime;

  function fakeRuntime() {
    return {
      getConfig: () => ({ agents: { planner: {} } }),
      getAgentRegistry: () => ({ list: () => [] }),
      getAgentDefinition: (name: string) => (name === "planner" ? {} : undefined),
      getStateService: () => service,
      getHttpRoutes: () => routes,
      getTimeProvider: () => ({ now: () => new Date(clock), timeZone: () => "Europe/Lisbon" }),
      wakeAgent,
      wakeRefusal: () => undefined,
    } as unknown as AgentRuntime;
  }

  /** Load the plugin into this test's runtime: every load of a test is a reload of the same one. */
  async function load(config?: Record<string, unknown>): Promise<LoadedPlugin> {
    runtime ??= fakeRuntime();
    const [plugin] = await loadPlugins(
      { plugins: [{ module: "builtin:directory", enabled: true, ...(config ? { config } : {}) }] } as never,
      async () => directoryPlugin,
      { context: createPluginContext({ runtime, events }) },
    );
    expect(plugin.ok).toBe(true);
    loaded.push(plugin);
    return plugin;
  }

  beforeEach(() => {
    for (const dispose of typeDisposers) dispose();
    typeDisposers = [];
    routes = new HttpRouteRegistry();
    loaded = [];
    runtime = undefined as unknown as AgentRuntime;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    for (const plugin of loaded) await plugin.stop?.();
  });

  it("wakes the owner through the runtime's waker, and a reload doesn't wake it twice", async () => {
    let release!: () => void;
    wakeAgent = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve("ran");
          held.push(release);
        }),
    );
    const first = await load();
    // Due a minute ago, as a check the directory moved on would be: no text to read it from again.
    await commitment("planner-watch", { checkAt: iso(START.getTime() - MINUTE) });
    await vi.waitFor(() => expect(wakeAgent).toHaveBeenCalledTimes(1));
    expect(wakeAgent.mock.calls[0][0]).toBe("planner");
    expect(wakeAgent.mock.calls[0][1]).toMatchObject({
      sessionKey: "commitment:planner-watch",
      wake: { kind: "commitment", ref: "planner-watch" },
    });

    // Reloaded while the turn runs: the new load starts nothing beside it, and finds nothing due after it.
    await first.stop?.();
    loaded = loaded.filter((p) => p !== first);
    const second = await load();
    await settle();
    expect(wakeAgent).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(async () => expect(texts(await read("planner-watch"))[0]).toBe(NO_CHANGE));
    // And once more, after the turn: the check moved on, so there's nothing due.
    await second.stop?.();
    loaded = loaded.filter((p) => p !== second);
    await load();
    await settle();
    expect(wakeAgent).toHaveBeenCalledTimes(1);
    expect((await read("planner-watch")).data.checkAt).toBe(iso(START.getTime() + DAY));
  });

  it("wakes no one with checks turned off, and still reads a check as it's written", async () => {
    wakeAgent = vi.fn(async () => "ran");
    await load({ checks: false });
    // Due a minute ago: with checks on, it would be woken at once (see above).
    await commitment("planner-watch", { checkAt: iso(START.getTime() - MINUTE) });
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(wakeAgent).not.toHaveBeenCalled();
    const r = await read("planner-watch");
    await service.patch(PERSON, { type: COMMITMENT_TYPE, id: "planner-watch" }, { nextCheck: "in 2 hours" }, r.version);
    await settle();
    expect((await read("planner-watch")).data.checkAt).toBe(iso(START.getTime() + 2 * HOUR));
  });

  it("takes its timer and listeners away when it's turned off", async () => {
    wakeAgent = vi.fn(async () => "ran");
    const plugin = await load();
    await plugin.stop?.();
    loaded = [];
    typeDisposers = DIRECTORY_TYPES.map((def) => stateTypeRegistry.register(def.name, { ...def }));
    await commitment("planner-watch", { checkAt: iso(START.getTime() - MINUTE) });
    await settle();
    expect(wakeAgent).not.toHaveBeenCalled();
    const decided = await events.waterfall("agent.pre_tool_use", {
      sessionId: "s",
      agent: "planner",
      projectId: null,
      tool: "exec",
      toolUseId: "t",
      cwd: "/",
      args: {},
      effect: "write",
      effectDeclared: true,
      wake: { kind: "commitment", ref: "planner-watch" },
    });
    expect(decided.deny).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// The guard, through a real runtime's agent loop
// --------------------------------------------------------------------------

describe("a check's turn, through the agent loop", () => {
  let home: string;
  let runtime: AgentRuntime;
  let plugins: LoadedPlugin[];
  let queue: Array<Array<{ name: string; arguments: Record<string, unknown> }>>;
  let outputs: Record<string, string[]>;
  let ran: string[];

  const provider: AIProvider = {
    id: "openai_compatible",
    name: "scripted",
    supportsTools: true,
    async chat(params): Promise<ChatResponse> {
      const usage = { input: 1, output: 1 };
      for (const m of params.messages) {
        if (m.role === "tool" && typeof m.content === "string") {
          const id = (m as { toolCallId?: string }).toolCallId ?? "";
          (outputs[id] ??= []).push(m.content);
        }
      }
      const calls = queue.shift();
      if (!calls) return { content: "done", usage, finishReason: "stop" };
      return {
        content: "",
        toolCalls: calls.map((c, i) => ({ id: `${c.name}-${i}`, ...c })),
        usage,
        finishReason: "tool_calls",
      };
    },
  };

  const probe = (name: string, effect?: "read" | "write"): Tool => ({
    name,
    description: `probe ${name}`,
    parameters: { type: "object", properties: {} },
    ...(effect ? { effect } : {}),
    async execute() {
      ran.push(name);
      return { success: true, output: `${name} ran` };
    },
  });

  function makeConfig(): AgentConfig {
    return {
      server: { port: 3000, host: "127.0.0.1" },
      database: { path: ":memory:" },
      providers: { openai_compatible: { baseUrl: "http://x", defaultModel: "x" } },
      agent: {
        defaultProvider: "openai_compatible",
        maxToolRounds: 4,
        maxHistoryTokens: 8000,
        temperature: 0.3,
        extraInstructions: "",
      },
      agents: { planner: { tools: ["commitment", "save_file", "fetch_page", "look_up", "state"] } },
      rooms: { maxWakesPerHour: 12 },
      tools: {},
      custom_tools: {},
      cron: { enabled: false, jobs: [] },
      context: { directory: "./data/context", kbDirectory: "./data/kb" },
      prompts: { allowShellExpansion: false, shellTimeoutMs: 5000, maxIncludeDepth: 5 },
      permissions: { defaultMode: "auto", timeoutMs: 0, timeoutAction: "reject", tools: {} },
      workflows: { directory: join(home, "workflows") },
      tasks: { backend: "native" as const },
      state: { backend: "sqlite" },
      plugins: [{ module: "builtin:directory", enabled: true }],
    } as unknown as AgentConfig;
  }

  beforeEach(async () => {
    for (const dispose of typeDisposers) dispose();
    typeDisposers = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    home = mkdtempSync(join(tmpdir(), "tai-checks-"));
    queue = [];
    outputs = {};
    ran = [];
    const config = makeConfig();
    runtime = new AgentRuntime(
      {
        configPath: "/dev/null",
        db,
        contextDir: join(home, "context"),
        kbDir: join(home, "kb"),
        createTools: (c, dir, path, opts) => [
          ...createTools(c, dir, path, opts),
          probe("save_file", "write"),
          probe("fetch_page"),
          probe("look_up", "read"),
        ],
        createProvider: () => ({ provider, model: "x" }),
      },
      () => config,
      config,
    );
    plugins = await loadPlugins(config, async () => directoryPlugin, {
      context: createPluginContext({ runtime, events: runtime.events }),
    });
    expect(plugins.map((p) => p.ok)).toEqual([true]);
    runtime.syncToolFactories();
  });

  afterEach(async () => {
    for (const plugin of plugins) await plugin.stop?.();
    rmSync(home, { recursive: true, force: true });
  });

  it("asks first: a write or a call that says nothing is refused, a read and its own commitment go through", async () => {
    const woke: unknown[] = [];
    runtime.events.on("agent.woken", (e) => woke.push(e));
    const logs: string[] = [];
    vi.mocked(console.log).mockImplementation((line: unknown) => void logs.push(String(line)));
    queue = [
      [
        { name: "save_file", arguments: {} },
        { name: "fetch_page", arguments: {} },
        { name: "look_up", arguments: {} },
        {
          name: "commitment",
          arguments: { action: "update", id: "planner-watch", note: "Prices unchanged.", nextCheck: "Friday 9am" },
        },
        // The core state tool says which of its calls only read: a check can read what it watches, not change it.
        { name: "state", arguments: { action: "get", type: COMMITMENT_TYPE, id: "planner-watch" } },
        { name: "state", arguments: { action: "patch", type: COMMITMENT_TYPE, id: "planner-watch", data: {} } },
      ],
    ];
    await runtime.getStateService().put(
      PERSON,
      {
        type: COMMITMENT_TYPE,
        id: "planner-watch",
        scope: "global",
        data: {
          owner: "planner",
          goal: "Watch hotel prices",
          status: "open",
          autonomy: "tell",
          checkAt: new Date(Date.now() - MINUTE).toISOString(),
        },
      },
      0,
    );
    await vi.waitFor(
      async () => {
        const r = await runtime.getStateService().get(PERSON, { type: COMMITMENT_TYPE, id: "planner-watch" });
        expect(texts(r as StateRecord)[0]).toBe("Prices unchanged.");
      },
      { timeout: 5000 },
    );
    expect(woke).toEqual([
      expect.objectContaining({
        agent: "planner",
        wake: { kind: "commitment", ref: "planner-watch" },
        target: "commitment:planner-watch",
      }),
    ]);
    expect(
      logs.some((l) => l.includes("[wake] waking planner in commitment:planner-watch for commitment (planner-watch)")),
    ).toBe(true);
    expect(ran).toEqual(["look_up"]);
    expect(outputs["save_file-0"]).toEqual([ASKS_FIRST]);
    expect(outputs["fetch_page-1"]).toEqual([notOpen("fetch_page")]);
    expect(outputs["look_up-2"]).toEqual(["look_up ran"]);
    expect(outputs["commitment-3"]?.[0]).toMatch(/^Updated planner-watch/);
    expect(outputs["state-4"]?.[0]).toContain("planner-watch");
    expect(outputs["state-5"]).toEqual([ASKS_FIRST]);
    // The agent set a new check, so that's the one kept.
    const r = await runtime.getStateService().get(PERSON, { type: COMMITMENT_TYPE, id: "planner-watch" });
    expect(r?.data.nextCheck).toBe("Friday 9am");
    expect(texts(r as StateRecord)).not.toContain(NO_CHANGE);
  });

  it("leaves a person's chat alone", async () => {
    queue = [[{ name: "save_file", arguments: {} }]];
    const session = runtime.findOrCreateSession({ key: "web:planner" });
    await runAgentLoop("save it", runtime.buildLoopOptions({ session, agentName: "planner" }));
    expect(ran).toEqual(["save_file"]);
    expect(outputs["save_file-0"]).toEqual(["save_file ran"]);
  });
});
