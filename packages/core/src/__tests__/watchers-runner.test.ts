/**
 * The watchers runner: when a watch is checked, what it writes down, and when
 * its owner is woken.
 *
 * The runner here is the real one, against a real world-state service on
 * SQLite and the real watcher-kind registry, with a test kind whose readings
 * the test sets. Only the waker is a recording double: what the real
 * `runtime.wakeAgent` does with a wake is covered by the plugin tests, which
 * load the runner into a real runtime.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { WakeAgentOptions, WakeOutcome } from "../agent/wake.js";
import { TypedEventBus } from "../events.js";
import { WATCH_TYPE, WATCH_TYPE_DEF } from "../plugins/watchers-records.js";
import {
  MAX_RUNNING,
  nextCheckAt,
  OWED_FOR_MS,
  resetWatchSchedule,
  TELL_RETRY_MS,
  WatchRunner,
} from "../plugins/watchers-runner.js";
import type { Disposer } from "../registry.js";
import { registerStateType } from "../state/registry.js";
import { type StateCaller, StateService } from "../state/service.js";
import type { StateChange, StateRecord } from "../state/types.js";
import {
  getWatcherKind,
  registerWatcherKind,
  validateWatchConfig,
  type WatcherKind,
  watcherResult,
  watchInterval,
} from "../watchers/registry.js";

const KINDS = { get: getWatcherKind, validate: validateWatchConfig, interval: watchInterval, result: watcherResult };
const PERSON: StateCaller = { actor: { kind: "user", name: "owner" }, source: { surface: "web" } };
const START = Date.parse("2026-10-22T10:00:00.000Z");
const HOUR = 3_600_000;

let db: Database.Database;
let service: StateService;
let events: TypedEventBus;
let clock: number;
let cleanup: Disposer[];
let runner: WatchRunner;

/** What the test kind reads next, per watch config `name`: a number, or an error to throw. */
let readings: Record<string, number | Error>;
/** Checks the test kind has run, by name, and the most running at once. */
let checked: string[];
let inFlight: number;
let mostInFlight: number;
/** While set, every check waits for it. */
let gate: Promise<void> | undefined;

let wakes: Array<{ agent: string } & WakeAgentOptions>;
let outcome: WakeOutcome;

const counter: WatcherKind<{ name: string }, { v: number }> = {
  kind: "counter",
  description: "A number the test sets.",
  schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
  defaultEvery: "1h",
  minEvery: "1m",
  async check({ name }, previous) {
    checked.push(name);
    inFlight++;
    mostInFlight = Math.max(mostInFlight, inFlight);
    try {
      if (gate) await gate;
      const v = readings[name] ?? 0;
      if (v instanceof Error) throw v;
      const change = previous && previous.v !== v ? `The count moved from ${previous.v} to ${v}.` : undefined;
      return { snapshot: { v }, value: v, ...(change ? { change } : {}) };
    } finally {
      inFlight--;
    }
  },
};

function makeRunner(): WatchRunner {
  return new WatchRunner({
    service: () => service,
    kinds: KINDS,
    wake: async (agent, opts) => {
      wakes.push({ agent, ...opts });
      return outcome;
    },
    fetchFor: () => async () => {
      throw new Error("no network in tests");
    },
    now: () => clock,
    log: () => {},
    warn: () => {},
    tickMs: 10 * HOUR,
  });
}

async function addWatch(name: string, extra: Record<string, unknown> = {}, owner = "planner"): Promise<StateRecord> {
  return service.put(PERSON, {
    type: WATCH_TYPE,
    id: name,
    scope: `agent:${owner}`,
    data: {
      owner,
      kind: "counter",
      config: { name },
      label: `${name} count`,
      every: "1h",
      status: "active",
      checkAt: new Date(clock).toISOString(),
      ...extra,
    },
  });
}

async function watch(id: string): Promise<StateRecord> {
  const record = await service.get(PERSON, { type: WATCH_TYPE, id });
  if (!record) throw new Error(`no watch ${id}`);
  return record;
}

/** One look, and everything it started, to the end. */
async function look(): Promise<void> {
  await runner.tick();
  await runner.idle();
}

beforeEach(() => {
  db = new Database(":memory:");
  events = new TypedEventBus();
  clock = START;
  service = new StateService({
    getConfig: () => ({ state: { backend: "sqlite" } }),
    db,
    events,
    now: () => new Date(clock),
  });
  cleanup = [registerStateType({ ...WATCH_TYPE_DEF }), registerWatcherKind(counter)];
  readings = {};
  checked = [];
  inFlight = 0;
  mostInFlight = 0;
  gate = undefined;
  wakes = [];
  outcome = "ran";
  resetWatchSchedule();
  runner = makeRunner();
});

afterEach(async () => {
  runner.stop();
  gate = undefined;
  await runner.idle();
  for (const dispose of cleanup.splice(0)) dispose();
  await service.close();
  db.close();
  vi.restoreAllMocks();
});

describe("the watchers runner", () => {
  it("takes a baseline on the first check and wakes nobody", async () => {
    await addWatch("visits");
    readings.visits = 4;
    await look();

    expect(checked).toEqual(["visits"]);
    expect(wakes).toEqual([]);
    const w = await watch("visits");
    expect(w.data.snapshot).toEqual({ basis: expect.any(String), data: { v: 4 } });
    expect(w.data.lastValue).toBe(4);
    expect(w.data.checkedAt).toBe(new Date(START).toISOString());
    expect(w.data.checkAt).toBe(new Date(START + HOUR).toISOString());
    expect(w.data.lastChange).toBeUndefined();
  });

  it("wakes the owner once when it changes, in the watch's own session, and records the change", async () => {
    await addWatch("visits", { note: "Tell the travel room if it passes 10." });
    readings.visits = 4;
    await look();
    const changes: StateChange[] = [];
    events.on("state.changed", (c) => changes.push(c));

    clock += HOUR;
    readings.visits = 12;
    await look();

    expect(wakes).toHaveLength(1);
    const [wake] = wakes;
    expect(wake.agent).toBe("planner");
    expect(wake.sessionKey).toBe("watch:visits");
    expect(wake.wake).toEqual({ kind: "watch", ref: "visits" });
    expect(wake.prompt).toContain('Your watch "visits count" saw a change.');
    expect(wake.prompt).toContain("The count moved from 4 to 12.");
    expect(wake.prompt).toContain("When you set it up, you asked: Tell the travel room if it passes 10.");
    expect(wake.prompt).toContain("Nobody is reading this session.");

    const w = await watch("visits");
    expect(w.data.lastChange).toEqual({
      at: new Date(START + HOUR).toISOString(),
      text: "The count moved from 4 to 12.",
    });
    expect(w.data.lastValue).toBe(12);
    // The change is a state.changed, made for the owner, so a subscription on watch records hears it.
    const change = changes.find((c) => c.after?.lastChange);
    expect(change).toMatchObject({ type: WATCH_TYPE, id: "visits", op: "update", source: { onBehalfOf: "planner" } });

    // The next look finds nothing due and wakes nobody again.
    await look();
    expect(wakes).toHaveLength(1);
  });

  it("stays quiet while nothing changes, and checks again only when it comes due", async () => {
    await addWatch("visits");
    readings.visits = 4;
    await look();
    clock += 30 * 60_000;
    await look();
    expect(checked).toEqual(["visits"]);

    clock += 30 * 60_000;
    await look();
    expect(checked).toEqual(["visits", "visits"]);
    expect(wakes).toEqual([]);
    expect((await watch("visits")).data.lastChange).toBeUndefined();
  });

  it("marks a watch broken after three failures in a row, says so once, and stops checking it", async () => {
    await addWatch("visits");
    readings.visits = 4;
    await look();

    readings.visits = new Error("hotels.example answered 503 Service Unavailable.");
    for (let i = 1; i <= 2; i++) {
      clock += HOUR;
      await look();
      const w = await watch("visits");
      expect(w.data.failures).toBe(i);
      expect(w.data.status).toBe("active");
    }
    expect(wakes).toEqual([]);

    clock += HOUR;
    await look();
    const broken = await watch("visits");
    expect(broken.data.status).toBe("broken");
    expect(broken.data.failures).toBe(3);
    expect(broken.data.lastError).toBe("hotels.example answered 503 Service Unavailable.");
    expect(wakes).toHaveLength(1);
    expect(wakes[0].prompt).toContain("stopped: its last 3 checks failed");
    expect(wakes[0].prompt).toContain("503 Service Unavailable");

    clock += 5 * HOUR;
    await look();
    expect(checked).toHaveLength(4);
    expect(wakes).toHaveLength(1);
  });

  it("counts failures in a row only: a good check in between starts the count again", async () => {
    await addWatch("visits");
    readings.visits = 4;
    await look();
    readings.visits = new Error("down");
    clock += HOUR;
    await look();
    clock += HOUR;
    await look();
    expect((await watch("visits")).data.failures).toBe(2);

    readings.visits = 4;
    clock += HOUR;
    await look();
    const w = await watch("visits");
    expect(w.data.failures).toBe(0);
    expect(w.data.lastError).toBeUndefined();
    expect(w.data.status).toBe("active");
  });

  it("leaves a failed check's snapshot alone, so the change after it is still measured from the last good one", async () => {
    await addWatch("visits");
    readings.visits = 4;
    await look();
    readings.visits = new Error("down");
    clock += HOUR;
    await look();
    readings.visits = 9;
    clock += HOUR;
    await look();
    expect(wakes.map((w) => w.prompt)).toEqual([expect.stringContaining("The count moved from 4 to 9.")]);
  });

  it("doesn't check a paused watch or a removed one", async () => {
    await addWatch("paused", { status: "paused" });
    const removed = await addWatch("removed");
    await service.archive(PERSON, { type: WATCH_TYPE, id: removed.id }, "not needed");
    await look();
    expect(checked).toEqual([]);
  });

  it("runs at most two checks at once, and never the same watch twice", async () => {
    let open!: () => void;
    gate = new Promise((resolve) => {
      open = resolve;
    });
    for (const name of ["a", "b", "c", "d"]) await addWatch(name);
    void runner.tick();
    await vi.waitFor(() => expect(inFlight).toBe(MAX_RUNNING));
    // More looks while both are busy start nothing more.
    await runner.tick();
    await runner.tick();
    expect(checked.sort()).toEqual(["a", "b"]);

    gate = undefined;
    open();
    await runner.idle();
    expect(mostInFlight).toBe(MAX_RUNNING);
    expect(checked.sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("holds two at a time across runners, so a reload's new runner can't start what the old one is checking", async () => {
    let open!: () => void;
    gate = new Promise((resolve) => {
      open = resolve;
    });
    await addWatch("a");
    void runner.tick();
    await vi.waitFor(() => expect(inFlight).toBe(1));

    // A reload: the old runner is stopped mid-check and a new one looks at once.
    runner.stop();
    const next = makeRunner();
    await next.tick();
    expect(checked).toEqual(["a"]);

    gate = undefined;
    open();
    await runner.idle();
    await next.idle();
    expect(checked).toEqual(["a"]);
    // What the old runner found is written down, and the new one waits for the next due time.
    expect((await watch("a")).data.checkAt).toBe(new Date(START + HOUR).toISOString());
    await next.tick();
    await next.idle();
    expect(checked).toEqual(["a"]);
    next.stop();
  });

  it("takes a new baseline after a person changes a watch's settings, rather than reporting the new page as a change", async () => {
    await addWatch("visits");
    readings.visits = 4;
    readings.other = 50;
    await look();
    await service.patch(PERSON, { type: WATCH_TYPE, id: "visits" }, { config: { name: "other" } });

    clock += HOUR;
    await look();
    expect(wakes).toEqual([]);
    expect((await watch("visits")).data.snapshot).toMatchObject({ data: { v: 50 } });

    readings.other = 51;
    clock += HOUR;
    await look();
    expect(wakes.map((w) => w.prompt)).toEqual([expect.stringContaining("The count moved from 50 to 51.")]);
  });

  it("keeps a wake that was turned away owed, and tells the owner once it can", async () => {
    await addWatch("visits");
    readings.visits = 4;
    await look();
    outcome = "at-ceiling";
    readings.visits = 7;
    clock += HOUR;
    await look();
    expect(wakes).toHaveLength(1);
    // Owed since the change; the retry is kept in memory, so turning the wake away writes nothing.
    const owed = await watch("visits");
    expect(owed.data.tellAt).toBe(new Date(START + HOUR).toISOString());

    // Not yet due again: no second try.
    clock += 60_000;
    await look();
    expect(wakes).toHaveLength(1);
    clock += TELL_RETRY_MS - 60_000;
    await look();
    expect(wakes).toHaveLength(2);
    clock += TELL_RETRY_MS;
    await look();
    expect(wakes).toHaveLength(3);
    expect((await watch("visits")).version).toBe(owed.version);

    outcome = "ran";
    clock += 2 * TELL_RETRY_MS;
    await look();
    expect(wakes).toHaveLength(4);
    expect(wakes[3].prompt).toContain("The count moved from 4 to 7.");
    expect(wakes[3].prompt).toContain("saw a change 20 minutes ago");
    expect((await watch("visits")).data.tellAt).toBeUndefined();
  });

  it("tells a change found while the owner is still in its turn about the last one, once that turn ends", async () => {
    await addWatch("visits", { every: "1m" });
    readings.visits = 4;
    await look();
    let finish!: () => void;
    const turn = new Promise<void>((resolve) => {
      finish = resolve;
    });
    runner = new WatchRunner({
      service: () => service,
      kinds: KINDS,
      wake: async (agent, opts) => {
        wakes.push({ agent, ...opts });
        if (wakes.length === 1) await turn;
        return "ran";
      },
      fetchFor: () => async () => new Response(""),
      now: () => clock,
      log: () => {},
      warn: () => {},
      tickMs: 10 * HOUR,
    });
    // Let the turn end even when an assertion fails, or it holds the watch's slot into the next test.
    onTestFinished(() => finish());
    readings.visits = 5;
    clock += 60_000;
    await runner.tick();
    await vi.waitFor(() => expect(wakes).toHaveLength(1));

    // The owner is still in that turn when the next check finds another change.
    readings.visits = 6;
    clock += 60_000;
    await runner.tick();
    await vi.waitFor(async () => expect((await watch("visits")).data.lastValue).toBe(6));
    expect(wakes).toHaveLength(1);
    expect((await watch("visits")).data.tellAt).toBe(new Date(clock).toISOString());

    // Told as soon as that turn ends, without waiting for the next tick.
    finish();
    await runner.idle();
    expect(wakes.map((w) => w.prompt)).toEqual([
      expect.stringContaining("The count moved from 4 to 5."),
      expect.stringContaining("The count moved from 5 to 6."),
    ]);
    expect((await watch("visits")).data.tellAt).toBeUndefined();
  });

  it("stops trying to tell after a day, and leaves the change on the record", async () => {
    await addWatch("visits", { every: "2 days" });
    readings.visits = 4;
    await look();
    outcome = "paused";
    readings.visits = 7;
    clock += 48 * HOUR;
    await look();
    expect(wakes).toHaveLength(1);
    clock += OWED_FOR_MS + TELL_RETRY_MS;
    await look();
    // Given up without another try.
    expect(wakes).toHaveLength(1);
    const w = await watch("visits");
    expect(w.data.tellAt).toBeUndefined();
    expect(w.data.status).toBe("active");
    expect(w.data.lastChange).toMatchObject({ text: "The count moved from 4 to 7." });
  });

  it("doesn't wake the owner about a watch a person paused while its wake was owed", async () => {
    await addWatch("visits");
    readings.visits = 4;
    await look();
    outcome = "at-ceiling";
    readings.visits = 7;
    clock += HOUR;
    await look();
    expect(wakes).toHaveLength(1);
    await service.patch(PERSON, { type: WATCH_TYPE, id: "visits" }, { status: "paused" });

    outcome = "ran";
    clock += TELL_RETRY_MS;
    await look();
    expect(wakes).toHaveLength(1);
    expect((await watch("visits")).data.tellAt).toBeUndefined();
  });

  it("pauses a watch whose owner isn't an agent any more, saying why", async () => {
    await addWatch("visits", {}, "retired");
    readings.visits = 4;
    await look();
    outcome = "gone";
    readings.visits = 5;
    clock += HOUR;
    await look();
    const w = await watch("visits");
    expect(w.data.status).toBe("paused");
    expect(w.data.lastError).toBe("Its owner retired isn't an agent any more.");
  });

  it("gives up a check that runs too long, and counts it as a failure", async () => {
    gate = new Promise(() => {});
    runner = new WatchRunner({
      service: () => service,
      kinds: KINDS,
      wake: async () => "ran",
      fetchFor: () => async () => new Response(""),
      now: () => clock,
      log: () => {},
      warn: () => {},
      tickMs: 10 * HOUR,
      checkTimeoutMs: 20,
    });
    await addWatch("visits");
    await look();
    const w = await watch("visits");
    expect(w.data.failures).toBe(1);
    expect(w.data.lastError).toBe("The check took longer than 1s.");
  });

  it("counts a result the registry refuses, such as an oversized snapshot, as a failure", async () => {
    const big: WatcherKind = {
      kind: "big",
      description: "Returns a snapshot over the cap.",
      schema: { type: "object" },
      defaultEvery: "1h",
      minEvery: "1m",
      check: () => ({ snapshot: { blob: "x".repeat(5000) } }),
    };
    cleanup.push(registerWatcherKind(big));
    await addWatch("visits", { kind: "big", config: {} });
    await look();
    const w = await watch("visits");
    expect(w.data.failures).toBe(1);
    expect(w.data.lastError).toMatch(/over the 4096-byte cap/);
    expect(w.data.snapshot).toBeUndefined();
  });

  it("waits, without counting failures, on a watch whose kind no loaded plugin brings", async () => {
    await addWatch("mail", { kind: "mail", config: { from: "someone" } });
    await look();
    const w = await watch("mail");
    expect(w.data.failures).toBeUndefined();
    expect(w.data.status).toBe("active");
    expect(w.data.lastError).toBe('No loaded plugin brings the "mail" kind, so it can\'t be checked.');
    expect(Date.parse(String(w.data.checkAt))).toBeGreaterThan(clock);
  });

  it("checks a watch a person made with no checkAt at once", async () => {
    await addWatch("visits", { checkAt: undefined });
    await look();
    expect(checked).toEqual(["visits"]);
  });

  it("drops what a check found when a person paused the watch while it ran", async () => {
    let open!: () => void;
    gate = new Promise((resolve) => {
      open = resolve;
    });
    await addWatch("visits");
    void runner.tick();
    await vi.waitFor(() => expect(inFlight).toBe(1));
    await service.patch(PERSON, { type: WATCH_TYPE, id: "visits" }, { status: "paused" });
    gate = undefined;
    open();
    await runner.idle();
    const w = await watch("visits");
    expect(w.data.status).toBe("paused");
    expect(w.data.snapshot).toBeUndefined();
  });
  it("writes nothing for a check that finds nothing new: no new version, no history row, no state.changed", async () => {
    await addWatch("visits");
    readings.visits = 4;
    await look();
    const baseline = await watch("visits");
    const rows = () => (db.prepare("SELECT COUNT(*) AS n FROM state_changes").get() as { n: number }).n;
    const before = rows();
    const changes: StateChange[] = [];
    events.on("state.changed", (c) => changes.push(c));

    for (let i = 1; i <= 5; i++) {
      clock += HOUR;
      await look();
    }
    expect(checked).toHaveLength(6);
    expect((await watch("visits")).version).toBe(baseline.version);
    expect(rows()).toBe(before);
    expect(changes).toEqual([]);
    // The record's checkAt lags; the runner's own schedule is what a list shows.
    expect(nextCheckAt(await watch("visits"))).toBe(new Date(START + 6 * HOUR).toISOString());

    // Something new is written down, once.
    readings.visits = 5;
    clock += HOUR;
    await look();
    expect(rows()).toBe(before + 2);
    expect(wakes).toHaveLength(1);
    expect((await watch("visits")).data.checkAt).toBe(new Date(START + 7 * HOUR).toISOString());
  });

  it("keeps quiet checks on time by its own schedule, and lets a person's checkAt win over it", async () => {
    await addWatch("visits");
    readings.visits = 4;
    await look();
    clock += HOUR;
    await look();
    expect(checked).toHaveLength(2);

    // The stored checkAt (an hour in) has passed, but the next check is due two hours in.
    clock += 30 * 60_000;
    await look();
    expect(checked).toHaveLength(2);

    // "Check now" on the State page.
    await service.patch(PERSON, { type: WATCH_TYPE, id: "visits" }, { checkAt: new Date(clock).toISOString() });
    await look();
    expect(checked).toHaveLength(3);
  });

  it("checks a quietly scheduled watch once at once after a restart, which forgets that schedule", async () => {
    await addWatch("visits");
    readings.visits = 4;
    await look();
    clock += HOUR;
    await look();
    clock += 10 * 60_000;
    await look();
    expect(checked).toHaveLength(2);

    resetWatchSchedule();
    runner.stop();
    runner = makeRunner();
    await look();
    expect(checked).toHaveLength(3);
    await look();
    expect(checked).toHaveLength(3);
  });

  it("reads every due watch, past the first page, so none waits behind quiet ones", async () => {
    const names = Array.from({ length: 105 }, (_, i) => `w${String(i).padStart(3, "0")}`);
    for (const name of names) await addWatch(name);
    await look();
    expect(new Set(checked).size).toBe(105);

    checked = [];
    clock += HOUR;
    await look();
    expect(checked.sort()).toEqual(names);
  });

  it("pauses a watch whose owner and scope disagree, and wakes nobody about it", async () => {
    await addWatch("visits", { owner: "planner" }, "writer");
    const w0 = await watch("visits");
    expect(w0.scope).toBe("agent:writer");
    await service.patch(PERSON, { type: WATCH_TYPE, id: "visits" }, { owner: "planner" });
    await look();
    const w = await watch("visits");
    expect(checked).toEqual([]);
    expect(wakes).toEqual([]);
    expect(w.data.status).toBe("paused");
    expect(w.data.lastError).toBe("Its owner field says planner, but it is kept in writer's private scope.");
  });

  it("pauses a watch whose settings a person broke, saying why, without running its kind", async () => {
    await addWatch("visits", { config: { name: 5 } });
    await look();
    const w = await watch("visits");
    expect(checked).toEqual([]);
    expect(w.data.status).toBe("paused");
    expect(w.data.failures).toBeUndefined();
    expect(w.data.lastError).toContain("Its settings don't suit a counter watch:");
    expect(w.data.lastError).toContain("`name`");
  });

  it("keeps a broken watch's notice owed while the owner is at its ceiling, and tells it once there's room", async () => {
    await addWatch("visits");
    readings.visits = 4;
    await look();
    outcome = "at-ceiling";
    readings.visits = new Error("hotels.example answered 503.");
    for (let i = 0; i < 3; i++) {
      clock += HOUR;
      await look();
    }
    expect((await watch("visits")).data.status).toBe("broken");
    expect(wakes).toHaveLength(1);
    expect((await watch("visits")).data.tellAt).toBeDefined();

    outcome = "ran";
    clock += TELL_RETRY_MS;
    await look();
    expect(wakes).toHaveLength(2);
    expect(wakes[1].prompt).toContain("stopped: its last 3 checks failed");
    expect((await watch("visits")).data.tellAt).toBeUndefined();
    clock += TELL_RETRY_MS;
    await look();
    expect(wakes).toHaveLength(2);
  });

  it("drops a broken notice still owed once a person sets the watch going again, rather than retell an old change", async () => {
    await addWatch("visits");
    readings.visits = 4;
    await look();
    readings.visits = 5;
    clock += HOUR;
    await look();
    expect(wakes).toHaveLength(1);
    outcome = "at-ceiling";
    readings.visits = new Error("down");
    for (let i = 0; i < 3; i++) {
      clock += HOUR;
      await look();
    }
    expect(wakes).toHaveLength(2);
    expect((await watch("visits")).data.tellAt).toBeDefined();

    readings.visits = 5;
    await service.patch(PERSON, { type: WATCH_TYPE, id: "visits" }, { status: "active", failures: 0 });
    outcome = "ran";
    clock += TELL_RETRY_MS;
    await look();
    expect(wakes).toHaveLength(2);
    expect((await watch("visits")).data.tellAt).toBeUndefined();
  });

  it("wakes an owner about one watch at a time, and the next once that turn ends", async () => {
    await addWatch("a", { every: "1m" });
    await addWatch("b", { every: "1m" });
    await addWatch("c", { every: "1m" }, "writer");
    readings.a = 1;
    readings.b = 1;
    readings.c = 1;
    await look();

    let finish!: () => void;
    const turn = new Promise<void>((resolve) => {
      finish = resolve;
    });
    onTestFinished(() => finish());
    const open: Record<string, number> = {};
    const mostOpen: Record<string, number> = {};
    runner.stop();
    runner = new WatchRunner({
      service: () => service,
      kinds: KINDS,
      wake: async (agent, opts) => {
        wakes.push({ agent, ...opts });
        open[agent] = (open[agent] ?? 0) + 1;
        mostOpen[agent] = Math.max(mostOpen[agent] ?? 0, open[agent]);
        try {
          if (agent === "planner") await turn;
          return "ran";
        } finally {
          open[agent]--;
        }
      },
      fetchFor: () => async () => new Response(""),
      now: () => clock,
      log: () => {},
      warn: () => {},
      tickMs: 10 * HOUR,
    });
    readings.a = 2;
    readings.b = 2;
    readings.c = 2;
    clock += 60_000;
    await runner.tick();
    // Another owner isn't held back; the planner's second watch waits, owed, for its first turn to end.
    await vi.waitFor(() => expect(wakes.map((w) => w.agent).sort()).toEqual(["planner", "writer"]));
    const first = String(wakes.find((w) => w.agent === "planner")?.wake?.ref);
    const second = first === "a" ? "b" : "a";
    await vi.waitFor(async () => expect((await watch(second)).data.tellAt).toBeDefined());
    expect(wakes.filter((w) => w.agent === "planner")).toHaveLength(1);

    finish();
    await runner.idle();
    expect(wakes.filter((w) => w.agent === "planner").map((w) => w.wake?.ref)).toEqual([first, second]);
    expect(mostOpen.planner).toBe(1);
    expect((await watch("a")).data.tellAt).toBeUndefined();
    expect((await watch("b")).data.tellAt).toBeUndefined();
  });
  it("checks from the record as it is now, not from a copy a look read before another check of it finished", async () => {
    await addWatch("visits");
    readings.visits = 4;
    await look();
    const stale = await watch("visits");
    clock += HOUR;
    readings.visits = 5;
    await look();
    expect(wakes).toHaveLength(1);

    // What a look hands over when it read its list before that check wrote.
    await (runner as unknown as { check(record: StateRecord): Promise<void> }).check(stale);
    await runner.idle();
    expect(checked).toHaveLength(2);
    expect(wakes).toHaveLength(1);
  });
  it("looks again when a check ends during a look that has already read past the slot it freed", async () => {
    for (const name of ["a", "b", "c"]) await addWatch(name);
    let open!: () => void;
    gate = new Promise((resolve) => {
      open = resolve;
    });
    onTestFinished(() => open());
    // A store slow enough that a look spans turns of the event loop: its owed read waits while held.
    let hold: Promise<void> | undefined;
    let release!: () => void;
    const slow = {
      query: async (caller: StateCaller, q: Parameters<StateService["query"]>[1]) => {
        if (hold && q.where && "tellAt" in q.where) await hold;
        return service.query(caller, q);
      },
      get: (caller: StateCaller, ref: { type: string; id: string }) => service.get(caller, ref),
      patch: (caller: StateCaller, ref: { type: string; id: string }, changes: Record<string, unknown>) =>
        service.patch(caller, ref, changes),
    } as unknown as StateService;
    runner.stop();
    runner = new WatchRunner({
      service: () => slow,
      kinds: KINDS,
      wake: async () => "ran",
      fetchFor: () => async () => new Response(""),
      now: () => clock,
      log: () => {},
      warn: () => {},
      tickMs: 10 * HOUR,
    });
    await runner.tick();
    expect(inFlight).toBe(MAX_RUNNING);

    // The next look finds no room, and stops at its owed read.
    hold = new Promise((resolve) => {
      release = resolve;
    });
    void runner.tick();
    await new Promise((resolve) => setImmediate(resolve));
    // Both checks end while it waits there.
    gate = undefined;
    open();
    await vi.waitFor(async () => {
      expect((await watch("a")).data.snapshot).toBeDefined();
      expect((await watch("b")).data.snapshot).toBeDefined();
    });
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await runner.idle();
    expect(checked.sort()).toEqual(["a", "b", "c"]);
  });
});
