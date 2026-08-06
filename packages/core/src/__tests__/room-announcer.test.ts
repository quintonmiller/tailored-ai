/**
 * Membership announcements, end to end: a real RoomStore emitting into a real
 * TypedEventBus, and a real RoomAnnouncer posting through a real
 * LocalRoomBackend. The only stub is the runtime handle, which the announcer
 * uses for exactly two things (the bus and the store).
 *
 * The case that matters most is the one that produces NOTHING: config-declared
 * subscriptions are re-applied on every reconcile, so announcing them would
 * post a wall of joins on every boot.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDatabase } from "../db/schema.js";
import { type RuntimeEventPayload, TypedEventBus } from "../events.js";
import { parseRoomTimestamp, RoomAnnouncer } from "../plugins/room-announcer.js";
import { LocalRoomBackend } from "../rooms/local.js";
import { registerRoomBackend, unregisterRoomBackend } from "../rooms/registry.js";
import { RoomStore } from "../rooms/store.js";
import type { AgentRuntime } from "../runtime.js";

let db: Database.Database;
let events: TypedEventBus;
let store: RoomStore;
let backend: LocalRoomBackend;

const REF = "local:eng";

function makeRuntime(): AgentRuntime {
  return { events, getRoomStore: () => store } as unknown as AgentRuntime;
}

/** Let the bus's fire-and-forget handler finish its awaited post. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const announcements = (): string[] =>
  (db.prepare("SELECT content FROM room_messages ORDER BY id").all() as Array<{ content: string }>).map(
    (r) => r.content,
  );

const changes = (): Array<RuntimeEventPayload<"room.membership_changed">> => {
  const seen: Array<RuntimeEventPayload<"room.membership_changed">> = [];
  events.on("room.membership_changed", (e) => {
    seen.push(e);
  });
  return seen;
};

beforeEach(() => {
  db = initDatabase(":memory:");
  events = new TypedEventBus();
  store = new RoomStore(db, events);
  backend = new LocalRoomBackend(db, store);
  registerRoomBackend(backend);
  store.upsertRoom({ ref: { backend: "local", id: "eng" }, name: "eng" });
});

afterEach(() => {
  // The registry is a module singleton — leaving `local` registered would leak
  // a backend bound to a closed database into the next test.
  unregisterRoomBackend("local");
  db.close();
});

describe("RoomStore membership events", () => {
  it("emits joined for a seat that did not exist", () => {
    const seen = changes();
    store.subscribe({ agent: "iris", roomRef: REF, source: "agent" });

    expect(seen).toEqual([{ roomRef: REF, agent: "iris", change: "joined", source: "agent" }]);
  });

  it("does not emit for an idempotent re-subscribe", () => {
    store.subscribe({ agent: "iris", roomRef: REF, source: "agent" });
    const seen = changes();

    // Both shapes of "already here": an exact repeat, and a re-subscribe that
    // changes the wake mode. Neither is a membership change.
    store.subscribe({ agent: "iris", roomRef: REF, source: "agent" });
    store.subscribe({ agent: "iris", roomRef: REF, wakeOn: "all", source: "agent" });

    expect(seen).toEqual([]);
  });

  it("emits left when a row was actually deleted", () => {
    store.subscribe({ agent: "iris", roomRef: REF, source: "agent" });
    const seen = changes();

    expect(store.unsubscribe("iris", REF)).toBe(true);
    expect(seen).toEqual([{ roomRef: REF, agent: "iris", change: "left", source: "agent" }]);
  });

  it("does not emit when unsubscribe removed nothing", () => {
    const seen = changes();

    expect(store.unsubscribe("nobody", REF)).toBe(false);
    expect(seen).toEqual([]);
  });

  it("labels config-declared subscriptions as such, both joining and leaving", () => {
    const seen = changes();
    store.subscribe({ agent: "iris", roomRef: REF, source: "config" });
    store.unsubscribe("iris", REF);

    expect(seen.map((e) => e.source)).toEqual(["config", "config"]);
  });

  it("works without a bus at all", () => {
    // Every CLI path and most tests construct the store bare. Membership
    // bookkeeping must not depend on anyone listening.
    const bare = new RoomStore(db);
    expect(() => bare.subscribe({ agent: "iris", roomRef: REF, source: "agent" })).not.toThrow();
    expect(bare.unsubscribe("iris", REF)).toBe(true);
  });
});

describe("RoomAnnouncer", () => {
  it("says so in the room when an agent joins", async () => {
    new RoomAnnouncer({ runtime: makeRuntime() });

    store.subscribe({ agent: "iris", roomRef: REF, source: "agent" });
    await flush();

    expect(announcements()).toEqual(["[room] **iris** joined this room."]);
  });

  it("says so when an agent leaves", async () => {
    new RoomAnnouncer({ runtime: makeRuntime() });
    store.subscribe({ agent: "iris", roomRef: REF, source: "agent" });
    await flush();

    store.unsubscribe("iris", REF);
    await flush();

    expect(announcements().at(-1)).toBe("[room] **iris** left this room.");
  });

  it("renders the creator's own join as the side effect of creating the room", async () => {
    // The exact case that went unnoticed: `room(action="create")` subscribes
    // the creator, so `channel-manager` was in a room it opened "for someone
    // else" and nothing ever said so.
    new RoomAnnouncer({ runtime: makeRuntime() });
    store.upsertRoom({ ref: { backend: "local", id: "iris-1on1" }, name: "iris-1on1" }, "channel-manager");

    store.subscribe({ agent: "channel-manager", roomRef: "local:iris-1on1", source: "agent" });
    await flush();

    expect(announcements()).toEqual(["[room] **channel-manager** created this room and joined it."]);
  });

  it("calls a later join by the creator an ordinary join", async () => {
    // Rejoining a room you opened last week is a decision, not a side effect.
    const now = vi.fn(() => Date.now() + 60 * 60 * 1000);
    new RoomAnnouncer({ runtime: makeRuntime(), now });
    store.upsertRoom({ ref: { backend: "local", id: "old" }, name: "old" }, "channel-manager");

    store.subscribe({ agent: "channel-manager", roomRef: "local:old", source: "agent" });
    await flush();

    expect(announcements()).toEqual(["[room] **channel-manager** joined this room."]);
  });

  it("suppresses config-sourced changes entirely", async () => {
    // `rooms.subscriptions` is re-applied on every reconcile and re-created
    // wholesale on a fresh database. Announcing those would post a wall of
    // joins on every boot, which is how a signal becomes noise.
    new RoomAnnouncer({ runtime: makeRuntime() });

    store.subscribe({ agent: "iris", roomRef: REF, source: "config" });
    store.subscribe({ agent: "coder", roomRef: REF, source: "config" });
    store.unsubscribe("iris", REF);
    await flush();

    expect(announcements()).toEqual([]);
  });

  it("announces an agent-made change in a room that also has config subscribers", async () => {
    new RoomAnnouncer({ runtime: makeRuntime() });

    store.subscribe({ agent: "coder", roomRef: REF, source: "config" });
    store.subscribe({ agent: "iris", roomRef: REF, source: "agent" });
    await flush();

    expect(announcements()).toEqual(["[room] **iris** joined this room."]);
  });

  it("is a no-op for a room that no longer resolves", async () => {
    new RoomAnnouncer({ runtime: makeRuntime() });

    events.emit("room.membership_changed", {
      roomRef: "local:deleted",
      agent: "iris",
      change: "joined",
      source: "agent",
    });
    await flush();

    expect(announcements()).toEqual([]);
  });

  it("is a no-op when the transport is not connected", async () => {
    new RoomAnnouncer({ runtime: makeRuntime() });
    unregisterRoomBackend("local");

    store.subscribe({ agent: "iris", roomRef: REF, source: "agent" });
    await flush();

    expect(announcements()).toEqual([]);
    // afterEach unregisters again; make that a no-op rather than a failure.
    registerRoomBackend(backend);
  });

  it("stops announcing once disposed, so a reload cannot double-post", async () => {
    const announcer = new RoomAnnouncer({ runtime: makeRuntime() });
    announcer.stop();

    store.subscribe({ agent: "iris", roomRef: REF, source: "agent" });
    await flush();

    expect(announcements()).toEqual([]);
  });
});

describe("RoomAnnouncer and archiving", () => {
  it("says so in the room, naming who and why", async () => {
    const announcer = new RoomAnnouncer({ runtime: makeRuntime() });
    store.archiveRoom(REF, { by: "alex", reason: "the trip is over" });
    await flush();

    // The line has to be written even though the room is already archived —
    // it is the one message that would otherwise never be posted, and without
    // it the other subscribers learn they were silenced by never being woken.
    expect(announcements()).toHaveLength(1);
    expect(announcements()[0]).toContain("alex");
    expect(announcements()[0]).toContain("the trip is over");
    announcer.stop();
  });

  it("announces a reopen too", async () => {
    const announcer = new RoomAnnouncer({ runtime: makeRuntime() });
    store.archiveRoom(REF, { by: "alex" });
    await flush();
    store.unarchiveRoom(REF, { by: "alex" });
    await flush();

    expect(announcements()).toHaveLength(2);
    expect(announcements()[1]).toMatch(/reopened/i);
    announcer.stop();
  });

  it("stays quiet when announceArchive is off", async () => {
    const announcer = new RoomAnnouncer({ runtime: makeRuntime(), announceArchive: false });
    store.archiveRoom(REF, { by: "alex", reason: "done" });
    await flush();

    expect(announcements()).toEqual([]);
    announcer.stop();
  });

  it("does not announce ordinary membership changes into an archived room", async () => {
    const announcer = new RoomAnnouncer({ runtime: makeRuntime() });
    store.archiveRoom(REF, { by: "alex", reason: "done" });
    await flush();

    // Seats can still be given up in an archived room; saying so in a room
    // nobody reads is noise.
    store.subscribe({ agent: "iris", roomRef: REF, source: "agent" });
    store.unsubscribe("iris", REF);
    await flush();

    expect(announcements()).toHaveLength(1);
    announcer.stop();
  });
});

describe("parseRoomTimestamp", () => {
  it("reads SQLite's zone-less datetime as the UTC it is", () => {
    // `datetime('now')` writes "YYYY-MM-DD HH:MM:SS" with no marker, and Date
    // would read that as local time — putting every room's creation hours away
    // from the join that followed it in any non-UTC deployment.
    expect(parseRoomTimestamp("2026-07-30 12:00:00")).toBe(Date.parse("2026-07-30T12:00:00Z"));
  });

  it("passes an ISO string through and rejects nonsense", () => {
    expect(parseRoomTimestamp("2026-07-30T12:00:00Z")).toBe(Date.parse("2026-07-30T12:00:00Z"));
    expect(parseRoomTimestamp("not a date")).toBeUndefined();
    expect(parseRoomTimestamp(undefined)).toBeUndefined();
  });
});
