/**
 * Mirroring agent-to-agent direct messages into a room.
 *
 * Same shape as the room-announcer tests: a real RoomStore, a real
 * TypedEventBus and a real LocalRoomBackend, with only the runtime handle
 * stubbed — the mirror uses it for the bus and the store and nothing else.
 *
 * The cases that matter most are the ones that produce NOTHING. A mirror is a
 * machine for making its own input if anything in the target room wakes on what
 * it posts, so "refuses to run" is the behaviour under test, not an edge case.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDatabase } from "../db/schema.js";
import { type RuntimeEventPayload, TypedEventBus } from "../events.js";
import { DmMirror, truncate } from "../plugins/dm-mirror.js";
import { LocalRoomBackend } from "../rooms/local.js";
import { registerRoomBackend, unregisterRoomBackend } from "../rooms/registry.js";
import { RoomStore } from "../rooms/store.js";
import type { AgentRuntime } from "../runtime.js";

let db: Database.Database;
let events: TypedEventBus;
let store: RoomStore;
let backend: LocalRoomBackend;

function makeRuntime(): AgentRuntime {
  return { events, getRoomStore: () => store } as unknown as AgentRuntime;
}

/** Let the bus's fire-and-forget handler finish its awaited post. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const posts = (): string[] =>
  (db.prepare("SELECT content FROM room_messages ORDER BY id").all() as Array<{ content: string }>).map(
    (r) => r.content,
  );

const exchange = (
  over: Partial<RuntimeEventPayload<"agent.messaged">> = {},
): RuntimeEventPayload<"agent.messaged"> => ({
  from: "planner",
  to: "coder",
  body: "are you free tonight?",
  reply: "yes, after eight",
  via: "dm",
  ...over,
});

beforeEach(() => {
  db = initDatabase(":memory:");
  events = new TypedEventBus();
  store = new RoomStore(db, events);
  backend = new LocalRoomBackend(db, store);
  registerRoomBackend(backend);
  store.upsertRoom({ ref: { backend: "local", id: "dmlog" }, name: "dm-log" });
});

afterEach(() => {
  unregisterRoomBackend("local");
  db.close();
});

describe("mirroring", () => {
  it("posts the message and the reply as one line", async () => {
    const mirror = new DmMirror({ runtime: makeRuntime(), room: "dm-log" });

    events.emit("agent.messaged", exchange());
    await flush();

    expect(posts()).toHaveLength(1);
    expect(posts()[0]).toContain("planner → coder");
    expect(posts()[0]).toContain("are you free tonight?");
    expect(posts()[0]).toContain("coder replied");
    expect(posts()[0]).toContain("yes, after eight");
    mirror.stop();
  });

  /**
   * The first of the two loop guards. An agent watching with `wakeOn: "named"`
   * must not be named by a mirrored line, or the mirror feeds itself.
   */
  it("addresses nobody, so a named-only watcher is not woken", async () => {
    // Asserted on the call rather than on storage: the local backend does not
    // persist an addressee at all, so only the post options can show that no
    // `to` was set — and `to` is what a `wakeOn: "named"` watcher reads.
    const spy = vi.spyOn(backend, "post");
    const mirror = new DmMirror({ runtime: makeRuntime(), room: "dm-log" });

    events.emit("agent.messaged", exchange());
    await flush();

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).not.toHaveProperty("to");
    mirror.stop();
  });

  it("stops mirroring once disposed", async () => {
    const mirror = new DmMirror({ runtime: makeRuntime(), room: "dm-log" });
    mirror.stop();

    events.emit("agent.messaged", exchange());
    await flush();

    expect(posts()).toHaveLength(0);
  });
});

describe("what it declines to mirror", () => {
  /** Delegation is machine-generated handoff and would bury the real traffic. */
  it("mirrors dm but not delegate by default", async () => {
    const mirror = new DmMirror({ runtime: makeRuntime(), room: "dm-log" });

    events.emit("agent.messaged", exchange({ via: "delegate" }));
    await flush();
    expect(posts()).toHaveLength(0);

    events.emit("agent.messaged", exchange({ via: "dm" }));
    await flush();
    expect(posts()).toHaveLength(1);
    mirror.stop();
  });

  it("mirrors delegate when asked to, and labels it", async () => {
    const mirror = new DmMirror({ runtime: makeRuntime(), room: "dm-log", via: ["dm", "delegate"] });

    events.emit("agent.messaged", exchange({ via: "delegate" }));
    await flush();

    expect(posts()[0]).toContain("(delegate)");
    mirror.stop();
  });

  it("honours an agent filter on either side of the exchange", async () => {
    const mirror = new DmMirror({ runtime: makeRuntime(), room: "dm-log", agents: ["reviewer"] });

    events.emit("agent.messaged", exchange({ from: "planner", to: "coder" }));
    await flush();
    expect(posts()).toHaveLength(0);

    events.emit("agent.messaged", exchange({ from: "planner", to: "reviewer" }));
    await flush();
    expect(posts()).toHaveLength(1);

    events.emit("agent.messaged", exchange({ from: "reviewer", to: "coder" }));
    await flush();
    expect(posts()).toHaveLength(2);
    mirror.stop();
  });

  it("truncates a long body and says how much it cut", async () => {
    const mirror = new DmMirror({ runtime: makeRuntime(), room: "dm-log", maxBodyChars: 10 });

    events.emit("agent.messaged", exchange({ body: "x".repeat(30) }));
    await flush();

    expect(posts()[0]).toContain("20 more characters");
    mirror.stop();
  });
});

describe("the loop guard", () => {
  /**
   * The guard the "no `to`" rule cannot cover: `wakeOn: "all"` wakes on an
   * unaddressed line too, so the mirror would feed itself through that agent.
   */
  it("refuses to mirror into a room somebody wakes on", async () => {
    store.subscribe({ agent: "coder", roomRef: "local:dmlog", wakeOn: "all", source: "config" });
    const mirror = new DmMirror({ runtime: makeRuntime(), room: "dm-log" });

    expect(mirror.blocked).toContain("coder (wakeOn: all)");

    events.emit("agent.messaged", exchange());
    await flush();
    expect(posts()).toHaveLength(0);
    mirror.stop();
  });

  it("allows a room watched only by a reader", () => {
    store.subscribe({ agent: "coder", roomRef: "local:dmlog", wakeOn: "none", source: "config" });
    const mirror = new DmMirror({ runtime: makeRuntime(), room: "dm-log" });

    expect(mirror.blocked).toBeNull();
    mirror.stop();
  });

  /**
   * An agent can subscribe itself at runtime, turning a safe room into a loop
   * with no config edit. Re-checking on reload is what catches that.
   */
  it("re-checks on reload, so a runtime subscribe disarms it", async () => {
    const mirror = new DmMirror({ runtime: makeRuntime(), room: "dm-log" });
    expect(mirror.blocked).toBeNull();

    store.subscribe({ agent: "coder", roomRef: "local:dmlog", wakeOn: "named", source: "agent" });
    events.emit("runtime.reloaded", { generation: 2 });

    expect(mirror.blocked).toContain("coder (wakeOn: named)");
    events.emit("agent.messaged", exchange());
    await flush();
    expect(posts()).toHaveLength(0);
    mirror.stop();
  });

  it("resumes once the offending subscription is gone", async () => {
    store.subscribe({ agent: "coder", roomRef: "local:dmlog", wakeOn: "all", source: "agent" });
    const mirror = new DmMirror({ runtime: makeRuntime(), room: "dm-log" });
    expect(mirror.blocked).not.toBeNull();

    store.unsubscribe("coder", "local:dmlog");
    events.emit("runtime.reloaded", { generation: 3 });

    expect(mirror.blocked).toBeNull();
    events.emit("agent.messaged", exchange());
    await flush();
    expect(posts()).toHaveLength(1);
    mirror.stop();
  });

  it("refuses when the configured room does not exist", async () => {
    const mirror = new DmMirror({ runtime: makeRuntime(), room: "nonexistent" });

    expect(mirror.blocked).toContain("no room named");
    events.emit("agent.messaged", exchange());
    await flush();
    expect(posts()).toHaveLength(0);
    mirror.stop();
  });

  it("does nothing at all without a configured room", async () => {
    const mirror = new DmMirror({ runtime: makeRuntime() });

    events.emit("agent.messaged", exchange());
    await flush();
    expect(posts()).toHaveLength(0);
    mirror.stop();
  });
});

describe("truncate", () => {
  it("leaves a short body alone", () => {
    expect(truncate("  hello  ", 100)).toBe("hello");
  });

  it("reports the remainder rather than trailing off", () => {
    expect(truncate("abcdefghij", 4)).toBe("abcd… _(6 more characters)_");
  });
});
