import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db/schema.js";
import type { RoomWatcher, ScheduledWakeOutcome } from "../rooms/watcher.js";
import type { AgentRuntime } from "../runtime.js";
import { ScheduleRunner } from "../schedules/runner.js";
import { ScheduleStore } from "../schedules/store.js";
import type { WakeContext } from "../schedules/wake-context.js";

/**
 * The firing rules.
 *
 * Three of these protect properties that are invisible until they break in
 * production: a slow turn re-fired underneath itself, an outage stampeding an
 * agent with every wake it slept through, and a room permanently at its ceiling
 * collecting a retry every five minutes for ever. None would show up as an
 * error — they show up as an agent that woke too much.
 */

let db: Database.Database;

const AGENT = "ea";
const ROOM = "discord:123";

interface FakeWatcher {
  calls: WakeContext[];
  outcome: ScheduledWakeOutcome;
  /** When set, runScheduledWake blocks here — used to hold a turn "in flight". */
  gate?: Promise<void>;
  runScheduledWake(agent: string, roomRef: string, ctx: WakeContext): Promise<ScheduledWakeOutcome>;
}

function fakeWatcher(outcome: ScheduledWakeOutcome = "ran"): FakeWatcher {
  return {
    calls: [],
    outcome,
    async runScheduledWake(_agent, _roomRef, ctx) {
      this.calls.push(ctx);
      if (this.gate) await this.gate;
      return this.outcome;
    },
  };
}

/** Hands back a promise plus the switch that resolves it. */
function openGate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

const asWatcher = (w: FakeWatcher) => w as unknown as RoomWatcher;

function fakeRuntime(opts: { paused?: boolean; maxDeferrals?: number } = {}): AgentRuntime {
  return {
    db,
    getConfig: () => ({
      schedules: {
        enabled: true,
        tickSeconds: 30,
        maxPerAgent: 20,
        minIntervalMinutes: 15,
        maxHorizonDays: 365,
        maxDeferrals: opts.maxDeferrals ?? 3,
      },
    }),
    isAgentsPaused: () => opts.paused === true,
    events: { emit: () => {} },
  } as unknown as AgentRuntime;
}

/** A schedule already due, so the very next tick picks it up. */
function dueOnce(store: ScheduleStore, at: Date) {
  return store.create({
    agent: AGENT,
    note: "check the deploy",
    kind: "once",
    source: "10 minutes",
    nextRunAt: at,
    targetKind: "room",
    target: ROOM,
  });
}

function dueRepeat(store: ScheduleStore, at: Date, intervalSeconds = 3600, anchor?: Date) {
  return store.create({
    agent: AGENT,
    note: "morning sweep",
    kind: "repeat",
    intervalSeconds,
    source: "every 1 hours",
    startsAt: anchor ?? null,
    nextRunAt: at,
    targetKind: "room",
    target: ROOM,
  });
}

const AGO = (minutes: number) => new Date(Date.now() - minutes * 60_000);

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("ScheduleRunner — claiming", () => {
  it("does not re-fire a wake whose turn is still running", async () => {
    const store = new ScheduleStore(db);
    const row = dueOnce(store, AGO(1));
    const watcher = fakeWatcher();
    const gate = openGate();
    watcher.gate = gate.promise;

    // Two runners over one database, which is what a restart mid-dispatch and
    // two overlapping ticks both look like. The in-process `running` set cannot
    // help here — only the claim can.
    const a = new ScheduleRunner({ runtime: fakeRuntime(), getRoomWatcher: () => asWatcher(watcher) });
    const b = new ScheduleRunner({ runtime: fakeRuntime(), getRoomWatcher: () => asWatcher(watcher) });

    const first = a.tick();
    await Promise.resolve();
    await b.tick();
    gate.release();
    await first;

    expect(watcher.calls).toHaveLength(1);
    expect(store.get(row.id)?.status).toBe("done");
  });

  it("counts a run only once the turn happened", async () => {
    const store = new ScheduleStore(db);
    const row = dueOnce(store, AGO(1));
    const runner = new ScheduleRunner({ runtime: fakeRuntime(), getRoomWatcher: () => asWatcher(fakeWatcher()) });

    await runner.tick();

    expect(store.get(row.id)?.run_count).toBe(1);
    expect(store.get(row.id)?.last_run_at).toBeTruthy();
  });
});

describe("ScheduleRunner — recurrence", () => {
  it("skips a whole outage in one wake rather than one per missed period", async () => {
    const store = new ScheduleStore(db);
    const anchor = AGO(60 * 5);
    const row = dueRepeat(store, AGO(60 * 3), 3600, anchor);
    const watcher = fakeWatcher();
    const runner = new ScheduleRunner({ runtime: fakeRuntime(), getRoomWatcher: () => asWatcher(watcher) });

    await runner.tick();
    // A second tick must find nothing: the row advanced past now, not by one
    // hour into the backlog it slept through.
    await runner.tick();

    expect(watcher.calls).toHaveLength(1);
    const after = store.get(row.id)!;
    expect(after.status).toBe("pending");
    expect(new Date(`${after.next_run_at.replace(" ", "T")}Z`).getTime()).toBeGreaterThan(Date.now());
  });

  it("expires a recurrence once its end date has passed", async () => {
    const store = new ScheduleStore(db);
    const row = store.create({
      agent: AGENT,
      note: "sweep",
      kind: "repeat",
      intervalSeconds: 3600,
      source: "every 1 hours",
      endsAt: AGO(1),
      nextRunAt: AGO(2),
      targetKind: "room",
      target: ROOM,
    });
    const runner = new ScheduleRunner({ runtime: fakeRuntime(), getRoomWatcher: () => asWatcher(fakeWatcher()) });

    await runner.tick();

    expect(store.get(row.id)?.status).toBe("expired");
  });

  it("tells the agent which run this is", async () => {
    const store = new ScheduleStore(db);
    dueRepeat(store, AGO(1), 3600, AGO(120));
    const watcher = fakeWatcher();
    const runner = new ScheduleRunner({ runtime: fakeRuntime(), getRoomWatcher: () => asWatcher(watcher) });

    await runner.tick();

    // Counted from 1: markRan lands after the turn, so the stored value is
    // still one behind when the prompt is built.
    expect(watcher.calls[0].runCount).toBe(1);
  });
});

describe("ScheduleRunner — pause", () => {
  it("keeps a one-shot due so it fires when the pause lifts", async () => {
    const store = new ScheduleStore(db);
    const row = dueOnce(store, AGO(1));
    const watcher = fakeWatcher();

    const paused = new ScheduleRunner({
      runtime: fakeRuntime({ paused: true }),
      getRoomWatcher: () => asWatcher(watcher),
    });
    await paused.tick();
    expect(watcher.calls).toHaveLength(0);
    // Still due. A commitment made before the pause is kept, not dropped.
    expect(store.get(row.id)?.status).toBe("pending");

    const live = new ScheduleRunner({ runtime: fakeRuntime(), getRoomWatcher: () => asWatcher(watcher) });
    await live.tick();
    expect(watcher.calls).toHaveLength(1);
  });

  it("skips a recurring occurrence rather than banking it", async () => {
    const store = new ScheduleStore(db);
    const row = dueRepeat(store, AGO(1), 3600, AGO(61));
    const watcher = fakeWatcher();
    const runner = new ScheduleRunner({
      runtime: fakeRuntime({ paused: true }),
      getRoomWatcher: () => asWatcher(watcher),
    });

    await runner.tick();

    expect(watcher.calls).toHaveLength(0);
    const after = store.get(row.id)!;
    expect(after.status).toBe("pending");
    expect(after.run_count).toBe(0);
    // Moved on: the next occurrence comes round anyway, so a heartbeat missed
    // during a pause is not owed.
    expect(new Date(`${after.next_run_at.replace(" ", "T")}Z`).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("ScheduleRunner — refusals", () => {
  it("defers a wake the room refused, then gives up", async () => {
    const store = new ScheduleStore(db);
    const row = dueOnce(store, AGO(1));
    const watcher = fakeWatcher("at-ceiling");
    // Walk the clock forward between ticks so each five-minute deferral has
    // come due, without the test waiting for it.
    let offsetMs = 0;
    const runner = new ScheduleRunner({
      runtime: fakeRuntime({ maxDeferrals: 2 }),
      getRoomWatcher: () => asWatcher(watcher),
      now: () => new Date(Date.now() + offsetMs),
    });

    await runner.tick();
    expect(store.get(row.id)?.status).toBe("pending");
    expect(store.get(row.id)?.deferrals).toBe(1);
    // A refused wake is not a run: counting it would both misreport the run
    // number to the agent and reset the streak this limit is counting.
    expect(store.get(row.id)?.run_count).toBe(0);

    offsetMs = 10 * 60_000;
    await runner.tick();
    expect(store.get(row.id)?.deferrals).toBe(2);

    // Third refusal is past the limit: a room permanently at its ceiling must
    // not collect a retry every five minutes for ever.
    offsetMs = 20 * 60_000;
    await runner.tick();
    expect(store.get(row.id)?.status).toBe("expired");
    expect(watcher.calls).toHaveLength(3);
  });

  it("retires a schedule whose room it can no longer wake in", async () => {
    const store = new ScheduleStore(db);
    const row = dueOnce(store, AGO(1));
    const runner = new ScheduleRunner({ runtime: fakeRuntime(), getRoomWatcher: () => asWatcher(fakeWatcher("gone")) });

    await runner.tick();

    expect(store.get(row.id)?.status).toBe("expired");
  });
});

describe("ScheduleRunner — lateness", () => {
  it("reports how late a wake is instead of pretending it is on time", async () => {
    const store = new ScheduleStore(db);
    dueOnce(store, AGO(14));
    const watcher = fakeWatcher();
    const runner = new ScheduleRunner({ runtime: fakeRuntime(), getRoomWatcher: () => asWatcher(watcher) });

    await runner.tick();

    expect(watcher.calls[0].lateBy).toBeGreaterThan(13 * 60_000);
  });
});
