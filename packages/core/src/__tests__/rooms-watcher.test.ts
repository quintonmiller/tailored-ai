/**
 * Rooms: the built-in `local` backend and the watcher's wake decision.
 *
 * Two halves, both exercised against the real schema:
 *
 *  - LocalRoomBackend — slugs, cursors, envelope round-trips, subscriber
 *    fan-out. This is the only backend that works without a live transport, so
 *    it is also the one that has to be right.
 *  - RoomWatcher.shouldWake — pure, and the thing standing between "two agents
 *    can hear each other" and "two agents talk forever". Tested directly, with
 *    a real IdentityResolver and hand-built messages.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDatabase } from "../db/schema.js";
import { IdentityResolver } from "../rooms/identities.js";
import { LocalRoomBackend } from "../rooms/local.js";
import { registerRoomBackend, unregisterRoomBackend } from "../rooms/registry.js";
import { RoomStore, type RoomSubscription, type WakeOn } from "../rooms/store.js";
import type { RoomMessage } from "../rooms/types.js";
import {
  describeWakeReason,
  looksLikeUninvokedPass,
  makeRoomSessionKey,
  RoomWatcher,
  todayLine,
} from "../rooms/watcher.js";
import type { AgentRuntime } from "../runtime.js";

let db: Database.Database;
let store: RoomStore;
let backend: LocalRoomBackend;

beforeEach(() => {
  db = initDatabase(":memory:");
  store = new RoomStore(db);
  backend = new LocalRoomBackend(db, store);
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

// --------------------------------------------------------------------------
// LocalRoomBackend
// --------------------------------------------------------------------------

describe("LocalRoomBackend.createRoom", () => {
  it("derives a url-safe native id from the room name", async () => {
    const room = await backend.createRoom({ name: "Eng Standup!" });

    expect(room.ref).toEqual({ backend: "local", id: "eng-standup" });
    expect(room.name).toBe("Eng Standup!");
    expect(await backend.getRoom("eng-standup")).not.toBeNull();
  });

  it("trims the name and records who opened the room", async () => {
    const room = await backend.createRoom({ name: "  Eng  ", purpose: "the eng room", createdBy: "quinton" });

    expect(room.name).toBe("Eng");
    expect(room.ref.id).toBe("eng");
    const stored = await backend.getRoom("eng");
    expect(stored?.purpose).toBe("the eng room");
    expect(stored?.createdBy).toBe("quinton");
  });

  it("suffixes -2 then -3 when different names slugify to the same id", async () => {
    // Distinct names, one slug: without the suffix walk the second room would
    // silently take over the first room's ref and its history.
    const first = await backend.createRoom({ name: "Stand Up" });
    const second = await backend.createRoom({ name: "stand-up" });
    const third = await backend.createRoom({ name: "Stand  up!" });

    expect([first.ref.id, second.ref.id, third.ref.id]).toEqual(["stand-up", "stand-up-2", "stand-up-3"]);
    // Three real rooms, not three aliases for one.
    expect((await backend.listRooms()).map((r) => r.ref.id).sort()).toEqual(["stand-up", "stand-up-2", "stand-up-3"]);
  });

  it("falls back to 'room' when a name has no slug-able characters", async () => {
    const room = await backend.createRoom({ name: "!!! ???" });
    expect(room.ref.id).toBe("room");
  });

  it("refuses to reuse a handle that already points at another room", async () => {
    await backend.createRoom({ name: "eng" });
    await expect(backend.createRoom({ name: "eng" })).rejects.toThrow(/already used by local:eng/);
    expect(await backend.listRooms()).toHaveLength(1);
  });

  it("seeds members as kind 'unknown' — the backend cannot classify identities", async () => {
    const room = await backend.createRoom({ name: "eng", members: ["coder", "quinton"] });

    const members = await backend.listMembers(room.ref.id);
    expect(members.map((m) => m.label).sort()).toEqual(["coder", "quinton"]);
    expect(members.every((m) => m.kind === "unknown")).toBe(true);

    await backend.addMember(room.ref.id, "supervisor");
    expect(await backend.listMembers(room.ref.id)).toHaveLength(3);
  });

  it("only lists rooms this backend owns", async () => {
    await backend.createRoom({ name: "eng" });
    store.upsertRoom({ ref: { backend: "discord", id: "1467386788640460822" }, name: "general" });

    expect((await backend.listRooms()).map((r) => r.ref.id)).toEqual(["eng"]);
    expect(await backend.getRoom("1467386788640460822")).toBeNull();
  });
});

describe("LocalRoomBackend messages", () => {
  it("round-trips speaker, addressees and body through the envelope", async () => {
    await backend.createRoom({ name: "eng" });
    const posted = await backend.post("eng", {
      body: "requirements are drafted — questions?",
      speaker: "supervisor",
      to: ["coder", "quinton"],
    });

    expect(posted?.raw).toBe("[supervisor] @coder @quinton requirements are drafted — questions?");

    const [fetched] = await backend.fetchSince("eng", null, 10);
    expect(fetched.speaker).toBe("supervisor");
    expect(fetched.to).toEqual(["coder", "quinton"]);
    expect(fetched.body).toBe("requirements are drafted — questions?");
    expect(fetched.authorId).toBe("supervisor");
    expect(fetched.authorLabel).toBe("supervisor");
    expect(fetched.id).toBe(posted?.id);
    expect(fetched.cursor).toBe(posted?.cursor);
    // No bot account exists at this layer, so self-ness is the watcher's call.
    expect(fetched.fromSelf).toBe(false);
  });

  it("stores an unattributed post without inventing a speaker", async () => {
    await backend.createRoom({ name: "eng" });
    const posted = await backend.post("eng", { body: "anyone around?" });

    expect(posted?.speaker).toBeUndefined();
    expect(posted?.to).toEqual([]);
    expect(posted?.authorId).toBe("unknown");
    expect(posted?.raw).toBe("anyone around?");
  });

  it("keeps `raw` intact when the naive parse misreads a bracketed body", async () => {
    // The backend has no identity list, so "[note] ..." parses as a speaker
    // here. The watcher re-parses `raw` with an identity-aware predicate — so
    // what matters is that the original text survives the round trip.
    await backend.createRoom({ name: "eng" });
    const posted = await backend.post("eng", { body: "[note] remember to renew the cert" });

    expect(posted?.raw).toBe("[note] remember to renew the cert");
    expect(posted?.speaker).toBe("note");

    const [fetched] = await backend.fetchSince("eng", null, 10);
    expect(fetched.raw).toBe("[note] remember to renew the cert");
  });

  it("emits zero-padded cursors so lexical order matches send order", async () => {
    await backend.createRoom({ name: "eng" });
    const a = await backend.post("eng", { body: "one", speaker: "coder" });
    const b = await backend.post("eng", { body: "two", speaker: "coder" });

    expect(a?.cursor).toHaveLength(16);
    expect(a!.cursor < b!.cursor).toBe(true);
  });

  it("throws a nameable error for a room that does not exist", async () => {
    await expect(backend.post("nope", { body: "hi" })).rejects.toThrow(/No local room "nope"/);
    await expect(backend.fetchSince("nope", null, 10)).rejects.toThrow(/No local room "nope"/);
  });

  it("returns the LAST `limit` messages in ascending order for a null cursor", async () => {
    await backend.createRoom({ name: "eng" });
    for (let i = 1; i <= 5; i += 1) await backend.post("eng", { body: `m${i}`, speaker: "coder" });

    const caughtUp = await backend.fetchSince("eng", null, 3);

    // "Catch me up", not "replay the room from the top" — newest three, oldest
    // first, so the prompt reads in conversation order.
    expect(caughtUp.map((m) => m.body)).toEqual(["m3", "m4", "m5"]);
  });

  it("scopes fetches to one room", async () => {
    await backend.createRoom({ name: "eng" });
    await backend.createRoom({ name: "ops" });
    await backend.post("eng", { body: "eng msg", speaker: "coder" });
    await backend.post("ops", { body: "ops msg", speaker: "coder" });

    expect((await backend.fetchSince("eng", null, 10)).map((m) => m.body)).toEqual(["eng msg"]);
    expect((await backend.fetchSince("ops", null, 10)).map((m) => m.body)).toEqual(["ops msg"]);
  });

  it("treats a corrupt cursor as absent instead of wedging the subscription", async () => {
    await backend.createRoom({ name: "eng" });
    for (let i = 1; i <= 3; i += 1) await backend.post("eng", { body: `m${i}`, speaker: "coder" });

    const rows = await backend.fetchSince("eng", "not-a-cursor", 2);
    expect(rows.map((m) => m.body)).toEqual(["m2", "m3"]);
  });

  it("pages the whole room without skipping or repeating across 9->10 and 99->100", async () => {
    // The load-bearing test for cursors. room_messages.id is an integer but a
    // cursor is compared as a STRING (RoomStore.advanceCursor), and "10" < "9"
    // lexically. Un-padded cursors would make advanceCursor refuse to move past
    // message 9, then past 99 — an agent stuck re-reading the same page forever.
    await backend.createRoom({ name: "log" });
    const roomRef = "local:log";
    const total = 105;
    for (let i = 1; i <= total; i += 1) await backend.post("log", { body: `m${i}`, speaker: "coder" });

    const all = await backend.fetchSince("log", null, total);
    expect(all).toHaveLength(total);
    expect([...all.map((m) => m.cursor)].sort()).toEqual(all.map((m) => m.cursor));

    // Walk it the way the watcher does: fetch a page, advance the stored
    // cursor to the last message in it, repeat.
    store.subscribe({ agent: "coder", roomRef, wakeOn: "all" });
    store.advanceCursor("coder", roomRef, all[0].cursor);

    const seen: string[] = [];
    for (let page = 0; page < 100; page += 1) {
      const cursor = store.getSubscription("coder", roomRef)!.cursor;
      const batch = await backend.fetchSince("log", cursor, 10);
      if (batch.length === 0) break;
      seen.push(...batch.map((m) => m.body));
      store.advanceCursor("coder", roomRef, batch[batch.length - 1].cursor);
    }

    const expected = Array.from({ length: total - 1 }, (_, i) => `m${i + 2}`);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("advances a stored cursor across the 9->10 boundary", async () => {
    // The narrow version of the walk above, isolating the string comparison.
    await backend.createRoom({ name: "log" });
    const roomRef = "local:log";
    for (let i = 1; i <= 12; i += 1) await backend.post("log", { body: `m${i}`, speaker: "coder" });
    const all = await backend.fetchSince("log", null, 12);

    store.subscribe({ agent: "coder", roomRef, wakeOn: "all" });
    store.advanceCursor("coder", roomRef, all[8].cursor); // m9
    store.advanceCursor("coder", roomRef, all[9].cursor); // m10

    expect(store.getSubscription("coder", roomRef)!.cursor).toBe(all[9].cursor);
    expect((await backend.fetchSince("log", all[9].cursor, 10)).map((m) => m.body)).toEqual(["m11", "m12"]);
  });
});

describe("LocalRoomBackend.onMessage", () => {
  it("delivers each post to every subscriber", async () => {
    await backend.createRoom({ name: "eng" });
    const first = vi.fn();
    const second = vi.fn();
    backend.onMessage(first);
    backend.onMessage(second);

    await backend.post("eng", { body: "hello", speaker: "coder" });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    const delivered = first.mock.calls[0][0] as RoomMessage;
    expect(delivered.body).toBe("hello");
    expect(delivered.speaker).toBe("coder");
    expect(delivered.room).toEqual({ backend: "local", id: "eng" });
  });

  it("does not let a throwing handler fail the post or starve its siblings", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await backend.createRoom({ name: "eng" });
    const boom = vi.fn(() => {
      throw new Error("subscriber exploded");
    });
    const after = vi.fn();
    backend.onMessage(boom);
    backend.onMessage(after);

    const posted = await backend.post("eng", { body: "still lands", speaker: "coder" });

    expect(posted?.body).toBe("still lands");
    expect(after).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();
    // The row is committed regardless of what subscribers did with it.
    expect((await backend.fetchSince("eng", null, 10)).map((m) => m.body)).toEqual(["still lands"]);
  });

  it("stops delivering after unsubscribe", async () => {
    await backend.createRoom({ name: "eng" });
    const handler = vi.fn();
    const off = backend.onMessage(handler);

    await backend.post("eng", { body: "one", speaker: "coder" });
    off();
    await backend.post("eng", { body: "two", speaker: "coder" });

    expect(handler).toHaveBeenCalledTimes(1);
    expect((handler.mock.calls[0][0] as RoomMessage).body).toBe("one");
  });

  it("lets a handler unsubscribe itself from inside the callback", async () => {
    await backend.createRoom({ name: "eng" });
    const handler = vi.fn(() => off());
    const off = backend.onMessage(handler);
    const sibling = vi.fn();
    backend.onMessage(sibling);

    await backend.post("eng", { body: "one", speaker: "coder" });
    await backend.post("eng", { body: "two", speaker: "coder" });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(sibling).toHaveBeenCalledTimes(2);
  });
});

// --------------------------------------------------------------------------
// RoomWatcher.shouldWake
// --------------------------------------------------------------------------

/** Enough runtime for the watcher to construct and resolve identities. */
function makeRuntime(agents: string[] = ["supervisor", "coder"]): AgentRuntime {
  return {
    getConfig: () => ({ agents: Object.fromEntries(agents.map((a) => [a, {}])) }),
    getOwnerId: () => undefined,
  } as unknown as AgentRuntime;
}

function makeWatcher(agents?: string[]): RoomWatcher {
  return new RoomWatcher({ runtime: makeRuntime(agents), store });
}

function sub(agent: string, wakeOn: WakeOn, over: Partial<RoomSubscription> = {}): RoomSubscription {
  return {
    id: 1,
    agent,
    roomRef: "local:eng",
    deliver: "push",
    wakeOn,
    pollSeconds: null,
    cursor: null,
    source: "config",
    lastWokeAt: null,
    hourBucket: null,
    wakesThisHour: 0,
    ...over,
  };
}

function message(over: Partial<RoomMessage> = {}): RoomMessage {
  return {
    id: "1",
    room: { backend: "local", id: "eng" },
    cursor: "0000000000000001",
    raw: "something happened",
    body: "something happened",
    to: [],
    mentions: [],
    authorId: "author",
    authorLabel: "author",
    fromSelf: false,
    createdAt: "2026-07-27 12:00:00",
    ...over,
  };
}

/** supervisor + coder are agents; quinton is a human. */
const identities = () =>
  new IdentityResolver({
    agentNames: ["supervisor", "coder"],
    declared: { quinton: { human: { local: "u-1" } } },
  });

describe("RoomWatcher.shouldWake — wakeOn: none", () => {
  it("never wakes, even when directly addressed by a human", () => {
    const watcher = makeWatcher();
    const addressed = message({ speaker: "quinton", to: ["coder"], body: "coder, ship it" });

    expect(watcher.shouldWake(sub("coder", "none"), addressed, identities())).toBe(false);
  });

  it("never wakes on general traffic either", () => {
    const watcher = makeWatcher();
    expect(watcher.shouldWake(sub("coder", "none"), message({ speaker: "quinton" }), identities())).toBe(false);
  });
});

describe("RoomWatcher.shouldWake — self-talk (the anti-runaway guarantee)", () => {
  it("does not wake an agent on its own message under wakeOn: all", () => {
    const watcher = makeWatcher();
    const own = message({ speaker: "coder", body: "on it" });

    expect(watcher.shouldWake(sub("coder", "all"), own, identities())).toBe(false);
  });

  it("does not wake an agent on its own message under wakeOn: addressed, even self-addressed", () => {
    const watcher = makeWatcher();
    const own = message({ speaker: "coder", to: ["coder"], body: "note to self" });

    expect(watcher.shouldWake(sub("coder", "addressed"), own, identities())).toBe(false);
  });

  it("compares its own label case-insensitively", () => {
    // A transport that title-cases display names must not defeat the guard.
    const watcher = makeWatcher();
    const own = message({ speaker: "Coder", body: "still me" });

    expect(watcher.shouldWake(sub("coder", "all"), own, identities())).toBe(false);
    expect(watcher.shouldWake(sub("coder", "addressed"), own, identities())).toBe(false);
  });

  it("keys self-ness on the identity LABEL, not the raw agent name", () => {
    // `planner` is a declared alias for an agent that isn't in `agents:`, so
    // the agent posts as "planner" and must not hear itself back.
    const ids = new IdentityResolver({
      agentNames: ["supervisor"],
      declared: { planner: { agent: "night-shift" }, quinton: { human: { local: "u-1" } } },
    });
    const watcher = makeWatcher(["supervisor"]);

    expect(watcher.shouldWake(sub("night-shift", "all"), message({ speaker: "planner" }), ids)).toBe(false);
    // ...but being named by that label still wakes it.
    expect(
      watcher.shouldWake(sub("night-shift", "addressed"), message({ speaker: "quinton", to: ["planner"] }), ids),
    ).toBe(true);
  });
});

describe("RoomWatcher.shouldWake — wakeOn: all", () => {
  it("wakes on another agent's message", () => {
    const watcher = makeWatcher();
    const other = message({ speaker: "supervisor", body: "status?" });

    expect(watcher.shouldWake(sub("coder", "all"), other, identities())).toBe(true);
  });

  it("wakes on a human's message that names nobody", () => {
    const watcher = makeWatcher();
    expect(watcher.shouldWake(sub("coder", "all"), message({ speaker: "quinton" }), identities())).toBe(true);
  });

  it("wakes on a message with no attributable speaker at all", () => {
    const watcher = makeWatcher();
    expect(watcher.shouldWake(sub("coder", "all"), message({ speaker: undefined }), identities())).toBe(true);
  });
});

describe("RoomWatcher.shouldWake — wakeOn: addressed", () => {
  it("wakes when named, case-insensitively", () => {
    const watcher = makeWatcher();
    const named = message({ speaker: "supervisor", to: ["CODER"], body: "take this one" });

    expect(watcher.shouldWake(sub("coder", "addressed"), named, identities())).toBe(true);
  });

  it("wakes when named alongside someone else", () => {
    const watcher = makeWatcher();
    const both = message({ speaker: "quinton", to: ["supervisor", "coder"] });

    expect(watcher.shouldWake(sub("coder", "addressed"), both, identities())).toBe(true);
  });

  it("does not wake agent A when only agent B is addressed", () => {
    const watcher = makeWatcher();
    const forSupervisor = message({ speaker: "quinton", to: ["supervisor"], body: "plan this" });

    expect(watcher.shouldWake(sub("coder", "addressed"), forSupervisor, identities())).toBe(false);
    expect(watcher.shouldWake(sub("supervisor", "addressed"), forSupervisor, identities())).toBe(true);
  });

  it("ignores unaddressed agent chatter — this is how two agents talk forever", () => {
    const watcher = makeWatcher();
    const chatter = message({ speaker: "supervisor", to: [], body: "thinking out loud" });

    expect(watcher.shouldWake(sub("coder", "addressed"), chatter, identities())).toBe(false);
  });

  it("wakes on a human talking to the room with no addressee", () => {
    const watcher = makeWatcher();
    const openQuestion = message({ speaker: "quinton", to: [], body: "is the deploy green?" });

    expect(watcher.shouldWake(sub("coder", "addressed"), openQuestion, identities())).toBe(true);
  });

  it("wakes when there is no speaker to attribute the message to", () => {
    // Plain transport text from a person the resolver has no label for still
    // reads as "someone said something to the room".
    const watcher = makeWatcher();
    const anonymous = message({ speaker: undefined, to: [], body: "hello?" });

    expect(watcher.shouldWake(sub("coder", "addressed"), anonymous, identities())).toBe(true);
  });

  it("does not wake on an unaddressed message from an unrecognized label", () => {
    // A speaker label that resolves to no identity is treated as not-human, so
    // it cannot wake an addressed-only agent without naming it. Declaring the
    // person under `rooms.identities` is what turns this on.
    const watcher = makeWatcher();
    const stranger = message({ speaker: "drive-by", to: [], body: "hey all" });

    expect(watcher.shouldWake(sub("coder", "addressed"), stranger, identities())).toBe(false);
    // Naming the agent works regardless of who is speaking.
    expect(
      watcher.shouldWake(sub("coder", "addressed"), message({ speaker: "drive-by", to: ["coder"] }), identities()),
    ).toBe(true);
  });
});

describe("RoomWatcher.shouldWake — the 'named' mode", () => {
  const identities = new IdentityResolver({
    agentNames: ["supervisor", "coder", "reviewer"],
    defaultBackend: "local",
    declared: { quinton: "u-quinton" },
  });

  const sub = (agent: string, wakeOn: "named" | "addressed"): RoomSubscription => ({
    id: 1,
    agent,
    roomRef: "local:eng",
    deliver: "push",
    wakeOn,
    pollSeconds: null,
    cursor: null,
    source: "config",
    lastWokeAt: null,
    hourBucket: null,
    wakesThisHour: 0,
  });

  const fromHuman = (body: string, to: string[] = []): RoomMessage => ({
    id: "1",
    room: { backend: "local", id: "eng" },
    cursor: "0000000000000001",
    raw: body,
    body,
    speaker: "quinton",
    to,
    mentions: [],
    authorId: "u-quinton",
    authorLabel: "quinton",
    fromSelf: false,
    createdAt: "2026-07-27T00:00:00Z",
  });

  it("stays quiet on a loose question, where 'addressed' answers", () => {
    const watcher = makeWatcher();
    // The reason this mode exists: three agents in one room must not produce
    // three answers to one unaddressed question.
    const loose = fromHuman("what's the status?");

    expect(watcher.shouldWake(sub("supervisor", "addressed"), loose, identities)).toBe(true);
    expect(watcher.shouldWake(sub("coder", "named"), loose, identities)).toBe(false);
    expect(watcher.shouldWake(sub("reviewer", "named"), loose, identities)).toBe(false);
  });

  it("still wakes when it is named explicitly", () => {
    const watcher = makeWatcher();
    const direct = fromHuman("please take this", ["coder"]);

    expect(watcher.shouldWake(sub("coder", "named"), direct, identities)).toBe(true);
    expect(watcher.shouldWake(sub("reviewer", "named"), direct, identities)).toBe(false);
  });

  it("does not wake on its own message even when its own name appears", () => {
    const watcher = makeWatcher();
    const own: RoomMessage = { ...fromHuman("done, over to <coder>", ["coder"]), speaker: "coder" };

    expect(watcher.shouldWake(sub("coder", "named"), own, identities)).toBe(false);
  });
});

describe("RoomWatcher.shouldWake — conversation depth", () => {
  const identities = new IdentityResolver({
    agentNames: ["supervisor", "coder"],
    defaultBackend: "local",
    declared: { quinton: "u-quinton" },
  });

  const sub = (agent: string): RoomSubscription => ({
    id: 1,
    agent,
    roomRef: "local:eng",
    deliver: "push",
    wakeOn: "addressed",
    pollSeconds: null,
    cursor: null,
    source: "config",
    lastWokeAt: null,
    hourBucket: null,
    wakesThisHour: 0,
  });

  const msg = (speaker: string, authorId: string, to: string[]): RoomMessage => ({
    id: "1",
    room: { backend: "local", id: "eng" },
    cursor: "0000000000000001",
    raw: "x",
    body: "x",
    speaker,
    to,
    mentions: [],
    authorId,
    authorLabel: speaker,
    fromSelf: false,
    createdAt: "2026-07-27T00:00:00Z",
  });

  it("stops waking once agents have talked past the cap without a human", () => {
    const watcher = makeWatcher();
    const fromAgent = msg("supervisor", "supervisor", ["coder"]);

    // Under the cap the reply is legitimate conversation.
    expect(watcher.shouldWake(sub("coder"), fromAgent, identities, 6)).toBe(true);
    // Past it, two polite agents would keep going forever.
    expect(watcher.shouldWake(sub("coder"), fromAgent, identities, 7)).toBe(false);
  });

  it("still wakes for a human no matter how deep the agents went", () => {
    const watcher = makeWatcher();
    const fromHuman = msg("quinton", "u-quinton", ["coder"]);

    expect(watcher.shouldWake(sub("coder"), fromHuman, identities, 99)).toBe(true);
  });
});

describe("RoomWatcher wake prompt", () => {
  it("names only the participants actually in the room", async () => {
    // Listing every agent in config put 18 names in front of the model, most
    // of whom were not in the room at all.
    const db = initDatabase(":memory:");
    const store = new RoomStore(db);
    store.upsertRoom({ ref: { backend: "local", id: "eng" }, name: "eng" });
    store.subscribe({ agent: "coder", roomRef: "local:eng" });
    store.subscribe({ agent: "planner", roomRef: "local:eng" });

    const backend = new LocalRoomBackend(db, store);
    registerRoomBackend(backend);
    await backend.post("eng", { body: "ping", speaker: "planner", to: ["coder"] });

    const watcher = new RoomWatcher({
      runtime: {
        getConfig: () => ({
          agents: {
            coder: {},
            planner: {},
            // Real, configured, and irrelevant to this room.
            researcher: {},
            "email-fetcher": {},
          },
          defaultChannel: "local",
          rooms: { identities: { quinton: "u-quinton" } },
        }),
        getOwnerId: () => undefined,
      } as unknown as AgentRuntime,
      store,
    });

    const prompt = (
      watcher as unknown as {
        buildPrompt: (
          sub: RoomSubscription,
          messages: RoomMessage[],
          roomName: string,
          label: string,
          identities: IdentityResolver,
        ) => string;
      }
    ).buildPrompt(
      store.getSubscription("coder", "local:eng")!,
      await backend.fetchSince("eng", null, 5),
      "eng",
      "coder",
      new IdentityResolver({
        agentNames: ["coder", "planner", "researcher", "email-fetcher"],
        defaultBackend: "local",
        declared: { quinton: "u-quinton" },
      }),
    );

    expect(prompt).toContain("planner");
    expect(prompt).toContain("quinton");
    expect(prompt).not.toContain("researcher");
    expect(prompt).not.toContain("email-fetcher");

    unregisterRoomBackend("local");
    db.close();
  });
});

describe("RoomWatcher — context and mid-body pings", () => {
  const identities = new IdentityResolver({
    agentNames: ["default", "generalist"],
    defaultBackend: "local",
    declared: { quinton: "u-quinton" },
  });

  const sub = (agent: string, wakeOn: WakeOn): RoomSubscription => ({
    id: 1,
    agent,
    roomRef: "local:eng",
    deliver: "push",
    wakeOn,
    pollSeconds: null,
    cursor: null,
    source: "config",
    lastWokeAt: null,
    hourBucket: null,
    wakesThisHour: 0,
  });

  const msg = (over: Partial<RoomMessage>): RoomMessage => ({
    id: "1",
    room: { backend: "local", id: "eng" },
    cursor: "0000000000000001",
    raw: "x",
    body: "x",
    to: [],
    mentions: [],
    authorId: "u-quinton",
    authorLabel: "quinton",
    fromSelf: false,
    createdAt: "2026-07-27T00:00:00Z",
    ...over,
  });

  it("wakes an agent named mid-sentence, not just in the envelope", () => {
    const watcher = makeWatcher();
    // "Done. Created list_directory. @generalist you're up" — addressed to the
    // human, but generalist is the one being paged.
    const paged = msg({
      speaker: "default",
      to: ["quinton"],
      mentions: ["generalist"],
      body: "Done, added the tool. @generalist you're up",
    });

    expect(watcher.shouldWake(sub("generalist", "named"), paged, identities)).toBe(true);
  });

  it("does not wake an agent merely mentioned by name in prose", () => {
    const watcher = makeWatcher();
    const prose = msg({ speaker: "quinton", to: ["default"], mentions: [], body: "review generalist's tools" });

    expect(watcher.shouldWake(sub("generalist", "named"), prose, identities)).toBe(false);
  });
});

describe("an agent that worked must not go silent", () => {
  it("reports what changed when the sign-off was a written-out pass", () => {
    // The real case: the coordinator edited task_list.md, then typed
    // room(action="pass") instead of calling it. The guard suppressed that as
    // noise and the person who asked saw nothing happen at all.
    expect(looksLikeUninvokedPass('room(action="pass")')).toBe(true);
  });

  it("still recognises a genuine decline", () => {
    expect(looksLikeUninvokedPass("Nothing needs attention right now.")).toBe(false);
  });
});

describe("RoomWatcher.wakeReason", () => {
  const identities = new IdentityResolver({
    agentNames: ["supervisor", "coder"],
    defaultBackend: "local",
    declared: { quinton: "u-quinton" },
  });

  const sub = (agent: string, wakeOn: WakeOn): RoomSubscription => ({
    id: 1,
    agent,
    roomRef: "local:eng",
    deliver: "push",
    wakeOn,
    pollSeconds: null,
    checkInMinutes: null,
    lastCheckIn: null,
    cursor: null,
    source: "config",
    lastWokeAt: null,
    hourBucket: null,
    wakesThisHour: 0,
  });

  const msg = (over: Partial<RoomMessage>): RoomMessage => ({
    id: "1",
    room: { backend: "local", id: "eng" },
    cursor: "0000000000000001",
    raw: "x",
    body: "x",
    to: [],
    mentions: [],
    authorId: "u-quinton",
    authorLabel: "quinton",
    fromSelf: false,
    createdAt: "2026-07-28T00:00:00Z",
    ...over,
  });

  it("distinguishes being named from answering the room", () => {
    // Without this you cannot tell why an agent woke, and wake policy is where
    // most room misbehaviour starts.
    const watcher = makeWatcher();
    const named = msg({ speaker: "quinton", to: ["coder"] });
    const loose = msg({ speaker: "quinton", to: [] });

    expect(watcher.wakeReason(sub("coder", "named"), named, identities)).toBe("named");
    expect(watcher.wakeReason(sub("coder", "addressed"), loose, identities)).toBe("loose-question");
    expect(watcher.wakeReason(sub("coder", "all"), loose, identities)).toBe("all");
  });

  it("returns null when the agent should not wake, and shouldWake agrees", () => {
    const watcher = makeWatcher();
    const forOther = msg({ speaker: "quinton", to: ["supervisor"] });

    expect(watcher.wakeReason(sub("coder", "named"), forOther, identities)).toBeNull();
    expect(watcher.shouldWake(sub("coder", "named"), forOther, identities)).toBe(false);
  });

  it("renders each reason in plain language", () => {
    expect(describeWakeReason("named")).toBe("named directly");
    expect(describeWakeReason("check-in")).toBe("scheduled check-in");
    expect(describeWakeReason("loose-question")).toBe("a person asked the room");
  });
});

describe("todayLine", () => {
  it("gives the agent a date it can reason from", () => {
    // Without it an agent infers the date and gets deadlines wrong — the
    // coordinator said "two days out" when it was one, and had the flight date
    // wrong until corrected.
    expect(todayLine(new Date("2026-07-30T12:00:00"))).toBe("Today is Thursday, July 30, 2026.");
  });

  it("names the weekday, since that is what people plan around", () => {
    expect(todayLine(new Date("2026-08-01T09:00:00"))).toContain("Saturday");
  });
});

describe("room session scope", () => {
  it("keeps rooms apart by default", () => {
    // What an agent does in one room cannot leak into another.
    expect(makeRoomSessionKey("discord:A", "coder")).toBe("room:discord.A:coder");
    expect(makeRoomSessionKey("discord:B", "coder")).toBe("room:discord.B:coder");
    expect(makeRoomSessionKey("discord:A", "coder")).not.toBe(makeRoomSessionKey("discord:B", "coder"));
  });

  it("collapses every room into one session when shared", () => {
    // An agent added to a new room otherwise starts blank — which is how
    // freshly-added agents reported unassigned tasks as their own work.
    expect(makeRoomSessionKey("discord:A", "ea", "shared")).toBe("room:all:ea");
    expect(makeRoomSessionKey("discord:B", "ea", "shared")).toBe("room:all:ea");
  });

  it("still separates agents from each other when shared", () => {
    expect(makeRoomSessionKey("discord:A", "ea", "shared")).not.toBe(
      makeRoomSessionKey("discord:A", "coder", "shared"),
    );
  });
});
