import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db/schema.js";
import { RoomStore } from "../rooms/store.js";
import { WAKE_ROOMS_KEY } from "../rooms/watcher.js";
import { fromDbTime, ScheduleStore } from "../schedules/store.js";
import type { ToolContext } from "../tools/interface.js";
import { ScheduleTool } from "../tools/schedule.js";

/**
 * The booking surface.
 *
 * The property worth most here is the echo: every accepted booking states the
 * absolute time it resolved to. A parser can be wrong and be caught, because
 * the agent is told what it actually booked in the same turn. A parser that is
 * wrong silently books the right-looking schedule at the wrong hour and nothing
 * downstream can tell.
 */

let db: Database.Database;
let store: ScheduleStore;
let rooms: RoomStore;

const AGENT = "ea";
const ROOM = "local:exec";

function tool(
  overrides: Partial<{
    maxPerAgent: number;
    minIntervalMinutes: number;
    maxHorizonDays: number;
    now: () => Date;
  }> = {},
) {
  return new ScheduleTool({
    store,
    rooms,
    limits: () => ({
      maxPerAgent: overrides.maxPerAgent ?? 20,
      minIntervalMinutes: overrides.minIntervalMinutes ?? 15,
      maxHorizonDays: overrides.maxHorizonDays ?? 365,
    }),
    ...(overrides.now ? { now: overrides.now } : {}),
  });
}

/** A turn woken for `rooms`, the way the watcher records it for the room tool. */
function ctx(wokenFor: string[] = []): ToolContext {
  const workingMemory = new Map<string, string>();
  if (wokenFor.length) workingMemory.set(WAKE_ROOMS_KEY, wokenFor.join(","));
  return {
    sessionId: "sess-1",
    workingDirectory: "/tmp",
    env: {},
    agentName: AGENT,
    workingMemory,
  };
}

beforeEach(() => {
  db = initDatabase(":memory:");
  store = new ScheduleStore(db);
  rooms = new RoomStore(db);
  rooms.upsertRoom({ ref: { backend: "local", id: "exec" }, name: "executive" });
  rooms.subscribe({ agent: AGENT, roomRef: ROOM, deliver: "push", wakeOn: "addressed" });
});

afterEach(() => {
  db.close();
});

describe("schedule — once", () => {
  it("books a relative time and echoes back the absolute one", async () => {
    const res = await tool().execute({ action: "once", when: "10 minutes", note: "check the deploy" }, ctx([ROOM]));

    expect(res.success).toBe(true);
    // The safety property: a model that meant something else sees the resolved
    // time now, while it can still fix it.
    expect(res.output).toMatch(/Scheduled \w+ for \w{3}, \w{3} \d+, \d{2}:\d{2} \(in 10m\)/);
    expect(res.output).toContain("#executive");

    const rows = store.listForAgent(AGENT);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("once");
    expect(rows[0].target_kind).toBe("room");
    expect(rows[0].target).toBe(ROOM);
  });

  it("says out loud when it assumed an hour", async () => {
    const soon = new Date(Date.now() + 30 * 86_400_000);
    const iso = `${soon.getFullYear()}-${String(soon.getMonth() + 1).padStart(2, "0")}-${String(soon.getDate()).padStart(2, "0")}`;
    const res = await tool().execute({ action: "once", when: iso, note: "n" }, ctx([ROOM]));

    expect(res.success).toBe(true);
    expect(res.output).toContain("09:00 was used");
  });

  it("refuses a time that has already passed", async () => {
    const res = await tool().execute({ action: "once", when: "2020-01-01 10:00", note: "n" }, ctx([ROOM]));

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/already passed/);
  });

  it("refuses a booking past the horizon", async () => {
    const res = await tool({ maxHorizonDays: 30 }).execute({ action: "once", when: "60 days", note: "n" }, ctx([ROOM]));

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/more than 30 days out/);
  });

  it("refuses a wake with no note", async () => {
    // A wake with no note arrives with nothing to act on, which is the one
    // failure the agent cannot recover from at wake time.
    const res = await tool().execute({ action: "once", when: "10 minutes" }, ctx([ROOM]));

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/note is required/);
  });

  it("answers an unreadable time with the grammar it wanted", async () => {
    const res = await tool().execute({ action: "once", when: "at some point", note: "n" }, ctx([ROOM]));

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/relative/);
    expect(res.error).toMatch(/tomorrow/);
  });

  it("uses the runtime provider's instant and timezone", async () => {
    const fixed = new ScheduleTool({
      store,
      rooms,
      limits: () => ({ maxPerAgent: 20, minIntervalMinutes: 15, maxHorizonDays: 365 }),
      timeProvider: {
        id: "fixed-test",
        timeZoneSource: "provider",
        now: () => new Date("2026-08-09T19:00:00.000Z"),
        timeZone: () => "America/Los_Angeles",
      },
    });

    const res = await fixed.execute({ action: "once", when: "tomorrow 9am", note: "n" }, ctx([ROOM]));

    expect(res.success).toBe(true);
    const row = store.listForAgent(AGENT)[0];
    expect(fromDbTime(row.next_run_at).toISOString()).toBe("2026-08-10T16:00:00.000Z");
    expect(fromDbTime(row.created_at).toISOString()).toBe("2026-08-09T19:00:00.000Z");
    expect(res.output).toContain("09:00");
  });
});

describe("schedule — repeat", () => {
  it("books a clock pattern and reports the first wake", async () => {
    const res = await tool().execute(
      { action: "repeat", every: "weekdays at 9am", note: "morning sweep" },
      ctx([ROOM]),
    );

    expect(res.success).toBe(true);
    expect(res.output).toContain('repeat "weekdays at 9am"');
    expect(res.output).toMatch(/First wake/);

    const row = store.listForAgent(AGENT)[0];
    expect(row.cron).toBe("0 9 * * 1-5");
    expect(row.interval_seconds).toBeNull();
  });

  it("stores a plain interval as elapsed time, not cron", async () => {
    await tool().execute({ action: "repeat", every: "every 2 hours", note: "n" }, ctx([ROOM]));

    const row = store.listForAgent(AGENT)[0];
    expect(row.interval_seconds).toBe(7200);
    expect(row.cron).toBeNull();
  });

  it("honours a future start for both the anchor and the first wake", async () => {
    const res = await tool().execute(
      { action: "repeat", every: "every 2 hours", starts: "3 days", note: "n" },
      ctx([ROOM]),
    );

    expect(res.success).toBe(true);
    const row = store.listForAgent(AGENT)[0];
    // The first wake is the start itself, not two hours after it, and not an
    // occurrence before the pattern was meant to become active.
    expect(row.starts_at).toBe(row.next_run_at);
    expect(fromDbTime(row.next_run_at).getTime()).toBeGreaterThan(Date.now() + 2.9 * 86_400_000);
  });

  it("refuses a pattern that fires more often than the floor", async () => {
    const res = await tool({ minIntervalMinutes: 15 }).execute(
      { action: "repeat", every: "every 5 minutes", note: "n" },
      ctx([ROOM]),
    );

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/15-minute floor/);
  });

  it("refuses a pattern with no occurrence before its end", async () => {
    // Pinned to a Wednesday. On the real clock this test asserts "no Monday
    // 08:30 in the next two hours", which is false for two hours every Monday
    // morning — it failed CI on 2026-08-10 at 07:23 UTC, and would have passed
    // again by 08:30 without anyone learning why. The tool takes an injectable
    // clock precisely so a schedule assertion never depends on the day it runs.
    const res = await tool({ now: () => new Date("2026-08-12T12:00:00Z") }).execute(
      { action: "repeat", every: "every monday at 8:30", until: "2 hours", note: "n" },
      ctx([ROOM]),
    );

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/no occurrence before/);
  });
});

describe("schedule — where the wake lands", () => {
  it("uses the room the turn was woken for", async () => {
    await tool().execute({ action: "once", when: "10 minutes", note: "n" }, ctx([ROOM]));
    expect(store.listForAgent(AGENT)[0].target).toBe(ROOM);
  });

  it("falls back to the session when no room woke it", async () => {
    const res = await tool().execute({ action: "once", when: "10 minutes", note: "n" }, ctx());

    expect(res.success).toBe(true);
    // Said plainly, because an agent that assumes it has been heard will not
    // use the tools that would actually reach someone.
    expect(res.output).toMatch(/reaches nobody on its own/);
    expect(store.listForAgent(AGENT)[0].target_kind).toBe("session");
  });

  it("asks which room when several woke it", async () => {
    rooms.upsertRoom({ ref: { backend: "local", id: "ops" }, name: "ops" });
    rooms.subscribe({ agent: AGENT, roomRef: "local:ops", deliver: "push", wakeOn: "addressed" });

    const res = await tool().execute({ action: "once", when: "10 minutes", note: "n" }, ctx([ROOM, "local:ops"]));

    // Picking one would be a guess, and a wake in the wrong room is worse than
    // a question.
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/name the one to wake in/);
  });

  it("refuses an explicit room the agent does not sit in", async () => {
    const res = await tool().execute(
      { action: "once", when: "10 minutes", note: "n", room: "local:somewhere-else" },
      ctx([ROOM]),
    );

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not subscribed/);
  });
});

describe("schedule — list and cancel", () => {
  it("lists what is booked, with the note", async () => {
    await tool().execute({ action: "once", when: "10 minutes", note: "check the deploy" }, ctx([ROOM]));
    const res = await tool().execute({ action: "list" }, ctx([ROOM]));

    expect(res.output).toContain("check the deploy");
    expect(res.output).toContain("#executive");
  });

  it("says so plainly when nothing is booked", async () => {
    const res = await tool().execute({ action: "list" }, ctx([ROOM]));
    expect(res.output).toBe("You have no wakes booked.");
  });

  it("cancels one, several, and all", async () => {
    const t = tool();
    for (const note of ["a", "b", "c"]) {
      await t.execute({ action: "once", when: "10 minutes", note }, ctx([ROOM]));
    }
    const ids = store.listForAgent(AGENT).map((r) => r.id);

    const one = await t.execute({ action: "cancel", id: ids[0] }, ctx([ROOM]));
    expect(one.success).toBe(true);
    expect(store.listForAgent(AGENT)).toHaveLength(2);

    const some = await t.execute({ action: "cancel", id: `${ids[1]}, ${ids[2]}` }, ctx([ROOM]));
    expect(some.success).toBe(true);
    expect(store.listForAgent(AGENT)).toHaveLength(0);

    await t.execute({ action: "once", when: "10 minutes", note: "d" }, ctx([ROOM]));
    const all = await t.execute({ action: "cancel", all: true }, ctx([ROOM]));
    expect(all.output).toMatch(/Cancelled all 1/);
    expect(store.listForAgent(AGENT)).toHaveLength(0);
  });

  it("names the ids it could not cancel rather than reporting a clean sweep", async () => {
    const t = tool();
    await t.execute({ action: "once", when: "10 minutes", note: "a" }, ctx([ROOM]));
    const id = store.listForAgent(AGENT)[0].id;

    const res = await t.execute({ action: "cancel", id: `${id},zzzz` }, ctx([ROOM]));

    // A partial cancel reading as a full one leaves the agent believing a wake
    // is gone when it is not.
    expect(res.output).toContain(`Cancelled ${id}`);
    expect(res.output).toContain("zzzz");
  });

  it("cannot cancel another agent's wake", async () => {
    await tool().execute({ action: "once", when: "10 minutes", note: "a" }, ctx([ROOM]));
    const id = store.listForAgent(AGENT)[0].id;

    const res = await tool().execute({ action: "cancel", id }, { ...ctx([ROOM]), agentName: "someone-else" });

    expect(res.success).toBe(false);
    expect(store.listForAgent(AGENT)).toHaveLength(1);
  });
});

describe("schedule — limits", () => {
  it("refuses past the per-agent cap and says how to make room", async () => {
    const t = tool({ maxPerAgent: 2 });
    await t.execute({ action: "once", when: "10 minutes", note: "a" }, ctx([ROOM]));
    await t.execute({ action: "once", when: "20 minutes", note: "b" }, ctx([ROOM]));

    const res = await t.execute({ action: "once", when: "30 minutes", note: "c" }, ctx([ROOM]));

    expect(res.success).toBe(false);
    expect(res.error).toMatch(/already have 2 wakes booked/);
    expect(res.error).toMatch(/list/);
  });

  it("is unavailable to a session with no agent identity", async () => {
    const res = await tool().execute({ action: "list" }, { ...ctx(), agentName: undefined });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/no agent identity/);
  });
});
