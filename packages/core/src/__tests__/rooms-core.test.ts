import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import SQLite from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDatabase } from "../db/schema.js";
import { TypedEventBus } from "../events.js";
import {
  addresses,
  extractLeadingAddressees,
  formatEnvelope,
  isValidIdentityLabel,
  mentionsIn,
  parseEnvelope,
} from "../rooms/envelope.js";
import { IdentityResolver, type RoomIdentityConfig } from "../rooms/identities.js";
import { RoomStore } from "../rooms/store.js";
import type { Room } from "../rooms/types.js";
import { describeToolCall, looksLikeUninvokedPass } from "../rooms/watcher.js";

// ---------------------------------------------------------------- envelopes

describe("parseEnvelope", () => {
  it("splits speaker, addressee and body out of a full envelope", () => {
    const parsed = parseEnvelope("[supervisor] <coder> I've drafted the requirements — questions?");

    expect(parsed.speaker).toBe("supervisor");
    expect(parsed.to).toEqual(["coder"]);
    expect(parsed.body).toBe("I've drafted the requirements — questions?");
  });

  it("round-trips through formatEnvelope", () => {
    const wire = formatEnvelope({ speaker: "supervisor", to: ["coder", "tester"], body: "  ship it  " });
    expect(wire).toBe("[supervisor] @coder @tester ship it");

    const parsed = parseEnvelope(wire);
    expect(parsed).toEqual({ speaker: "supervisor", to: ["coder", "tester"], body: "ship it" });
  });

  it("reads a bare message as body with no speaker and no addressees", () => {
    const parsed = parseEnvelope("just a human typing");
    expect(parsed.speaker).toBeUndefined();
    expect(parsed.to).toEqual([]);
    expect(parsed.body).toBe("just a human typing");
  });

  it("reads a leading <name> as an addressee without inventing a speaker", () => {
    const parsed = parseEnvelope("<coder> can you take this?");
    expect(parsed.speaker).toBeUndefined();
    expect(parsed.to).toEqual(["coder"]);
    expect(parsed.body).toBe("can you take this?");
  });

  it("collects a run of addressees and dedupes repeats", () => {
    const parsed = parseEnvelope("[supervisor] <coder> <tester> <coder> stand-up in five");
    expect(parsed.to).toEqual(["coder", "tester"]);
    expect(parsed.body).toBe("stand-up in five");
  });

  it("never reads a Discord user mention as an addressee", () => {
    // The whole reason the identity charset excludes "@": Discord renders a
    // ping as "<@123456>". Parsing that as an addressee would make every
    // mention address a nonexistent agent named "123456".
    const parsed = parseEnvelope("<@123456> can you look at the deploy?");

    expect(parsed.to).toEqual([]);
    expect(parsed.speaker).toBeUndefined();
    expect(parsed.body).toBe("<@123456> can you look at the deploy?");
  });

  it("never reads a Discord channel link, role ping or emoji as an addressee", () => {
    expect(parseEnvelope("<#1234567890123456789> is where that lives").to).toEqual([]);
    expect(parseEnvelope("<@&998877> heads up").to).toEqual([]);
    expect(parseEnvelope("<:shipit:1234> nice").to).toEqual([]);
    expect(parseEnvelope("<:shipit:1234> nice").body).toBe("<:shipit:1234> nice");
  });

  it("keeps a mention intact even when a real addressee follows it", () => {
    // Only the LEADING run of <name> counts, and a mention is not a name, so
    // the scan stops at it. The safety property under test is that "123" never
    // becomes an addressee and the text survives untouched.
    const parsed = parseEnvelope("<@123> <coder> ping");

    expect(parsed.to).not.toContain("123");
    expect(parsed.to).toEqual([]);
    expect(parsed.body).toBe("<@123> <coder> ping");
  });

  it("still finds the speaker when the body opens with a Discord mention", () => {
    const parsed = parseEnvelope("[alex] <@123456> what's the status?", (l) => l === "alex");
    expect(parsed.speaker).toBe("alex");
    expect(parsed.to).toEqual([]);
    expect(parsed.body).toBe("<@123456> what's the status?");
  });

  it("keeps an unknown bracket as body text when an isKnown predicate is given", () => {
    const known = (label: string) => ["supervisor", "coder"].includes(label);
    const parsed = parseEnvelope("[note] remember to renew the domain", known);

    expect(parsed.speaker).toBeUndefined();
    expect(parsed.body).toBe("[note] remember to renew the domain");
  });

  it("treats any well-formed bracket as a speaker when no predicate is given", () => {
    const parsed = parseEnvelope("[note] remember to renew the domain");
    expect(parsed.speaker).toBe("note");
    expect(parsed.body).toBe("remember to renew the domain");
  });

  it("stops the addressee scan at the first unknown name", () => {
    const known = (label: string) => label === "coder";
    const parsed = parseEnvelope("<coder> <ghost> take a look", known);

    expect(parsed.to).toEqual(["coder"]);
    expect(parsed.body).toBe("<ghost> take a look");
  });

  it("treats <name> in the middle of a sentence as body text", () => {
    const parsed = parseEnvelope("[supervisor] I already asked <coder> about it");
    expect(parsed.speaker).toBe("supervisor");
    expect(parsed.to).toEqual([]);
    expect(parsed.body).toBe("I already asked <coder> about it");
  });

  it("requires the speaker to lead — an addressee first leaves the bracket in the body", () => {
    const parsed = parseEnvelope("<coder> [supervisor] hello");
    expect(parsed.speaker).toBeUndefined();
    expect(parsed.to).toEqual(["coder"]);
    expect(parsed.body).toBe("[supervisor] hello");
  });

  it("tolerates leading whitespace and collapses the gap after the envelope", () => {
    const parsed = parseEnvelope("   [supervisor]    <coder>    hi there  ");
    expect(parsed.speaker).toBe("supervisor");
    expect(parsed.to).toEqual(["coder"]);
    expect(parsed.body).toBe("hi there");
  });

  it("rejects an over-long bracket rather than truncating it", () => {
    const long = "a".repeat(65);
    const parsed = parseEnvelope(`[${long}] hello`);
    expect(parsed.speaker).toBeUndefined();
    expect(parsed.body).toBe(`[${long}] hello`);
  });
});

describe("formatEnvelope", () => {
  it("omits the envelope entirely for a plain body", () => {
    expect(formatEnvelope({ body: "hello" })).toBe("hello");
  });

  it("drops addressees that are not valid identity labels", () => {
    // A model that hands back "@coder" or "someone else" must not be able to
    // inject characters that change how the line parses.
    const wire = formatEnvelope({ speaker: "supervisor", to: ["coder", "@everyone", "two words"], body: "hi" });

    expect(wire).toBe("[supervisor] @coder hi");
    expect(parseEnvelope(wire).to).toEqual(["coder"]);
  });

  it("emits an addressee-only line when there is no speaker", () => {
    expect(formatEnvelope({ to: ["coder"], body: "ping" })).toBe("@coder ping");
  });
});

describe("isValidIdentityLabel", () => {
  it("accepts letters, digits, underscore, dot and dash", () => {
    expect(isValidIdentityLabel("coder")).toBe(true);
    expect(isValidIdentityLabel("code_reviewer-2.0")).toBe(true);
    expect(isValidIdentityLabel("a".repeat(64))).toBe(true);
  });

  it("rejects the characters that would break envelope parsing", () => {
    expect(isValidIdentityLabel("@123456")).toBe(false);
    expect(isValidIdentityLabel("#general")).toBe(false);
    expect(isValidIdentityLabel("two words")).toBe(false);
    expect(isValidIdentityLabel("ns:label")).toBe(false);
    expect(isValidIdentityLabel("")).toBe(false);
    expect(isValidIdentityLabel("a".repeat(65))).toBe(false);
  });
});

describe("addresses", () => {
  it("matches regardless of case", () => {
    expect(addresses(["Coder"], "coder")).toBe(true);
    expect(addresses(["coder"], "CODER")).toBe(true);
  });

  it("is false for a room-wide message and for someone else's name", () => {
    expect(addresses([], "coder")).toBe(false);
    expect(addresses(["tester"], "coder")).toBe(false);
  });
});

// --------------------------------------------------------------- identities

describe("IdentityResolver", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("derives an identity for every configured agent", () => {
    const ids = new IdentityResolver({ agentNames: ["supervisor", "coder"] });

    expect(ids.get("supervisor")).toEqual({ label: "supervisor", kind: "agent", agent: "supervisor" });
    expect(ids.isKnown("coder")).toBe(true);
    expect(ids.labels().sort()).toEqual(["coder", "supervisor"]);
  });

  it("looks up labels case-insensitively and ignores surrounding whitespace", () => {
    const ids = new IdentityResolver({ agentNames: ["Supervisor"] });

    expect(ids.get("SUPERVISOR")?.agent).toBe("Supervisor");
    expect(ids.isKnown("  supervisor  ")).toBe(true);
    expect(ids.isKnown("supervis")).toBe(false);
  });

  it("does not list one person twice under two names", () => {
    // Naming yourself in `rooms.identities` is the documented way to be called
    // something better than "owner" — but it used to ADD a label rather than
    // replace one, so agents were shown "Known participants: …, owner, alex"
    // for a single human. Two names for one person is two chances to pick the
    // wrong one, with nothing to say they are the same account.
    const ids = new IdentityResolver({
      agentNames: ["coder"],
      declared: { alex: "111111111111111111" },
      ownerNativeIds: { discord: "111111111111111111" },
    });

    expect(ids.labels().sort()).toEqual(["alex", "coder"]);
    expect(ids.get("owner")).toBeUndefined();
    expect(ids.byNativeId("discord", "111111111111111111")?.label).toBe("alex");
  });

  it("keeps the implicit owner when the declared human is somebody else", () => {
    const ids = new IdentityResolver({
      declared: { dana: "999" },
      ownerNativeIds: { discord: "111111111111111111" },
    });

    expect(ids.labels().sort()).toEqual(["dana", "owner"]);
    expect(ids.byNativeId("discord", "111111111111111111")?.label).toBe("owner");
  });

  it("carries the implicit owner's other transports onto the declared label", () => {
    // The declared form is a bare Discord id; the implicit identity may know
    // the same person on Slack. Dropping it would silently stop resolving them
    // there — the merge is what makes replacing the label safe.
    const ids = new IdentityResolver({
      declared: { alex: { human: { discord: "111111111111111111" } } },
      ownerNativeIds: { discord: "111111111111111111", slack: "U123" },
    });

    expect(ids.get("owner")).toBeUndefined();
    expect(ids.byNativeId("slack", "U123")?.label).toBe("alex");
    expect(ids.byNativeId("discord", "111111111111111111")?.label).toBe("alex");
  });

  it("lets a declared identity shadow a derived agent of the same name", () => {
    const ids = new IdentityResolver({
      agentNames: ["alex", "coder"],
      declared: { alex: "111111111111111111" },
    });

    expect(ids.get("alex")?.kind).toBe("human");
    expect(ids.get("alex")?.agent).toBeUndefined();
    expect(ids.all()).toHaveLength(2);
  });

  it("treats a bare string declaration as a human account id", () => {
    const ids = new IdentityResolver({
      defaultBackend: "discord",
      declared: { alex: "111111111111111111" },
    });

    expect(ids.get("alex")).toEqual({
      label: "alex",
      kind: "human",
      declared: true,
      nativeIds: { discord: "111111111111111111" },
    });
  });

  it("files a bare string under the deployment's default transport, not a hardcoded one", () => {
    const slackOnly = new IdentityResolver({
      defaultBackend: "slack",
      declared: { alex: "U123" },
    });

    // Guessing "discord" here would leave the human unrecognizable on Slack,
    // and shouldWake's human/agent split would then misfire on their messages.
    expect(slackOnly.byNativeId("slack", "U123")?.label).toBe("alex");
    expect(slackOnly.byNativeId("discord", "U123")).toBeUndefined();
  });

  it("spreads a bare string across every backend the owner is known on", () => {
    const ids = new IdentityResolver({
      ownerNativeIds: { discord: "1", slack: "U2" },
      declared: { ops: "999" },
    });

    expect(ids.get("ops")?.nativeIds).toEqual({ discord: "999", slack: "999" });
  });

  it("keeps a per-backend human declaration exactly as written", () => {
    const declared: Record<string, RoomIdentityConfig> = {
      ops: { human: { discord: "22233344455566677", slack: "U123" } },
    };
    const ids = new IdentityResolver({ ownerNativeIds: { discord: "1" }, declared });

    expect(ids.get("ops")?.nativeIds).toEqual({ discord: "22233344455566677", slack: "U123" });
  });

  it("maps a declared alias onto an agent", () => {
    const ids = new IdentityResolver({ declared: { planner: { agent: "supervisor" } } });

    expect(ids.get("planner")).toEqual({ label: "planner", kind: "agent", agent: "supervisor", declared: true });
    expect(ids.labelForAgent("supervisor")).toBe("planner");
  });

  it("rejects labels that would break envelope parsing, with a warning", () => {
    const declared: Record<string, RoomIdentityConfig> = {
      "two words": "1",
      "@everyone": "2",
      ["x".repeat(65)]: "3",
      good: "4",
    };
    const ids = new IdentityResolver({ declared });

    expect(ids.labels()).toEqual(["good"]);
    expect(ids.isKnown("two words")).toBe(false);
    expect(ids.isKnown("@everyone")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("skips a declaration that names neither an agent nor a human", () => {
    const ids = new IdentityResolver({ declared: { ops: {} } });

    expect(ids.isKnown("ops")).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("silently skips an agent whose name cannot be an identity label", () => {
    const ids = new IdentityResolver({ agentNames: ["code reviewer", "coder"] });

    expect(ids.labels()).toEqual(["coder"]);
    expect(ids.isKnown("code reviewer")).toBe(false);
  });

  it("registers the owner only when an account id is known", () => {
    expect(new IdentityResolver({}).isKnown("owner")).toBe(false);
    expect(new IdentityResolver({ ownerNativeIds: {} }).isKnown("owner")).toBe(false);

    const ids = new IdentityResolver({ ownerNativeIds: { discord: "42" } });
    expect(ids.get("owner")).toEqual({ label: "owner", kind: "human", nativeIds: { discord: "42" } });
  });

  it("honours a custom owner label", () => {
    const ids = new IdentityResolver({ ownerNativeIds: { discord: "42" }, ownerLabel: "alex" });

    expect(ids.isKnown("owner")).toBe(false);
    expect(ids.get("alex")?.nativeIds).toEqual({ discord: "42" });
  });

  it("does not alias the owner's ids to later mutations of the input", () => {
    const owner = { discord: "42" };
    const ids = new IdentityResolver({ ownerNativeIds: owner });
    owner.discord = "changed";

    expect(ids.get("owner")?.nativeIds).toEqual({ discord: "42" });
  });

  it("falls back to the raw agent name when no identity claims it", () => {
    const ids = new IdentityResolver({ agentNames: ["coder"] });

    expect(ids.labelForAgent("ghost")).toBe("ghost");
    expect(ids.labelForAgent("coder")).toBe("coder");
  });

  it("resolves a native account id back to its identity, per backend", () => {
    const ids = new IdentityResolver({
      agentNames: ["coder"],
      ownerNativeIds: { discord: "111111111111111111" },
      declared: { ops: { human: { slack: "U123" } } },
    });

    expect(ids.byNativeId("discord", "111111111111111111")?.label).toBe("owner");
    expect(ids.byNativeId("slack", "U123")?.label).toBe("ops");
    // Right id, wrong transport: a Discord id must never match a Slack lookup.
    expect(ids.byNativeId("slack", "111111111111111111")).toBeUndefined();
    expect(ids.byNativeId("discord", "nobody")).toBeUndefined();
  });
});

// -------------------------------------------------------------------- store

const cursor = (n: number) => String(n).padStart(16, "0");

const room = (id: string, name: string, purpose?: string): Room => ({
  ref: { backend: "local", id },
  name,
  purpose,
});

describe("RoomStore rooms", () => {
  let db: Database.Database;
  let store: RoomStore;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new RoomStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("stores a room and returns it with a canonical ref", () => {
    const saved = store.upsertRoom(room("eng", "eng", "engineering chatter"), "supervisor");

    expect(saved.ref).toEqual({ backend: "local", id: "eng" });
    expect(saved.name).toBe("eng");
    expect(saved.purpose).toBe("engineering chatter");
    expect(saved.createdAt).toBeTruthy();
  });

  it("rejects a name already held by a different room", () => {
    store.upsertRoom(room("eng-1", "eng"));

    expect(() => store.upsertRoom(room("eng-2", "eng"))).toThrow(/already used by local:eng-1/);
    expect(store.getRoomByName("eng")?.ref.id).toBe("eng-1");
    expect(store.listRooms()).toHaveLength(1);
  });

  it("rejects a name clash across backends too", () => {
    store.upsertRoom(room("eng-1", "eng"));

    expect(() => store.upsertRoom({ ref: { backend: "discord", id: "1234567890123456789" }, name: "eng" })).toThrow(
      /already used by local:eng-1/,
    );
  });

  it("allows re-upserting the same ref and keeps a purpose that was not resent", () => {
    store.upsertRoom(room("eng", "eng", "engineering chatter"));
    const again = store.upsertRoom(room("eng", "eng"));

    expect(again.purpose).toBe("engineering chatter");
    expect(store.listRooms()).toHaveLength(1);
  });

  it("renames a room in place when the same ref comes back under a new name", () => {
    store.upsertRoom(room("eng", "eng"));
    store.upsertRoom(room("eng", "engineering"));

    expect(store.getRoomByName("engineering")?.ref.id).toBe("eng");
    expect(store.getRoomByName("eng")).toBeNull();
    expect(store.listRooms()).toHaveLength(1);
  });

  it("resolves by registered name and by raw ref", () => {
    store.upsertRoom(room("standup", "standup"));

    expect(store.resolve("standup")?.ref.id).toBe("standup");
    expect(store.resolve("local:standup")?.ref.id).toBe("standup");
    expect(store.resolve(" standup ")?.ref.id).toBe("standup");
    expect(store.resolve("nope")).toBeNull();
    expect(store.resolve("local:nope")).toBeNull();
  });

  it("accepts a RoomRef object or its string form for lookups", () => {
    store.upsertRoom(room("standup", "standup"));

    expect(store.getRoomByRef({ backend: "local", id: "standup" })?.name).toBe("standup");
    expect(store.getRoomByRef("local:standup")?.name).toBe("standup");
    expect(store.getRoomByRef("local:missing")).toBeNull();
  });

  it("lists rooms by name", () => {
    store.upsertRoom(room("c", "charlie"));
    store.upsertRoom(room("a", "alpha"));
    store.upsertRoom(room("b", "bravo"));

    expect(store.listRooms().map((r) => r.name)).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("removes a room together with its subscriptions and members", () => {
    store.upsertRoom(room("eng", "eng"));
    store.upsertRoom(room("ops", "ops"));
    store.subscribe({ agent: "coder", roomRef: "local:eng" });
    store.putMember("local:eng", { id: "coder", label: "coder", kind: "agent" });
    store.subscribe({ agent: "coder", roomRef: "local:ops" });

    store.removeRoom("local:eng");

    expect(store.getRoomByRef("local:eng")).toBeNull();
    expect(store.listSubscriptionsForRoom("local:eng")).toEqual([]);
    expect(store.listMembers("local:eng")).toEqual([]);
    // The other room is untouched.
    expect(store.listSubscriptionsForAgent("coder").map((s) => s.roomRef)).toEqual(["local:ops"]);
  });
});

describe("RoomStore subscriptions", () => {
  let db: Database.Database;
  let store: RoomStore;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new RoomStore(db);
    store.upsertRoom(room("eng", "eng"));
  });

  afterEach(() => {
    db.close();
  });

  it("creates a subscription with sane defaults", () => {
    const sub = store.subscribe({ agent: "coder", roomRef: "local:eng" });

    expect(sub).toMatchObject({
      agent: "coder",
      roomRef: "local:eng",
      deliver: "push",
      wakeOn: "addressed",
      pollSeconds: null,
      cursor: null,
      source: "agent",
      wakesThisHour: 0,
    });
  });

  it("does NOT reset an existing cursor when a subscription is re-declared", () => {
    // A config reload re-runs subscribe() for every declared row. If that reset
    // the cursor, every agent would re-read and re-answer the whole backlog on
    // each restart.
    store.subscribe({ agent: "coder", roomRef: "local:eng", source: "config" });
    store.advanceCursor("coder", "local:eng", cursor(42));

    const again = store.subscribe({
      agent: "coder",
      roomRef: "local:eng",
      source: "config",
      wakeOn: "all",
      deliver: "poll",
      pollSeconds: 60,
      initialCursor: cursor(1),
    });

    expect(again.cursor).toBe(cursor(42));
    expect(again.wakeOn).toBe("all");
    expect(again.deliver).toBe("poll");
    expect(again.pollSeconds).toBe(60);
    expect(store.listSubscriptions()).toHaveLength(1);
  });

  it("honours initialCursor only for a brand-new subscription", () => {
    const fresh = store.subscribe({ agent: "coder", roomRef: "local:eng", initialCursor: cursor(7) });
    expect(fresh.cursor).toBe(cursor(7));

    const reused = store.subscribe({ agent: "coder", roomRef: "local:eng", initialCursor: cursor(99) });
    expect(reused.cursor).toBe(cursor(7));
  });

  it("keeps one row per (agent, room) but separate rows per agent and per room", () => {
    store.upsertRoom(room("ops", "ops"));
    store.subscribe({ agent: "coder", roomRef: "local:eng" });
    store.subscribe({ agent: "coder", roomRef: "local:eng", wakeOn: "all" });
    store.subscribe({ agent: "coder", roomRef: "local:ops" });
    store.subscribe({ agent: "supervisor", roomRef: "local:eng" });

    expect(store.listSubscriptions()).toHaveLength(3);
    expect(store.listSubscriptionsForAgent("coder").map((s) => s.roomRef)).toEqual(["local:eng", "local:ops"]);
    expect(store.listSubscriptionsForRoom("local:eng").map((s) => s.agent)).toEqual(["coder", "supervisor"]);
  });

  it("normalizes unknown deliver and wakeOn values coming back out of SQLite", () => {
    store.subscribe({ agent: "coder", roomRef: "local:eng", deliver: "poll", wakeOn: "none" });
    db.prepare("UPDATE room_subscriptions SET deliver = 'carrier-pigeon', wake_on = 'sometimes'").run();

    const sub = store.getSubscription("coder", "local:eng")!;
    expect(sub.deliver).toBe("push");
    expect(sub.wakeOn).toBe("addressed");
  });

  it("reports whether an unsubscribe actually removed anything", () => {
    store.subscribe({ agent: "coder", roomRef: "local:eng" });

    expect(store.unsubscribe("coder", "local:eng")).toBe(true);
    expect(store.unsubscribe("coder", "local:eng")).toBe(false);
    expect(store.getSubscription("coder", "local:eng")).toBeNull();
  });

  it("prunes only config-sourced rows that are no longer declared", () => {
    store.upsertRoom(room("ops", "ops"));
    store.subscribe({ agent: "coder", roomRef: "local:eng", source: "config" });
    store.subscribe({ agent: "supervisor", roomRef: "local:eng", source: "config" });
    store.subscribe({ agent: "coder", roomRef: "local:ops", source: "agent" });

    const removed = store.pruneConfigSubscriptions([{ agent: "coder", roomRef: "local:eng" }]);

    expect(removed).toBe(1);
    expect(
      store
        .listSubscriptions()
        .map((s) => `${s.agent} ${s.roomRef}`)
        .sort(),
    ).toEqual(["coder local:eng", "coder local:ops"]);
  });

  it("never prunes an agent-created subscription, even when nothing is declared", () => {
    store.subscribe({ agent: "coder", roomRef: "local:eng", source: "agent" });

    expect(store.pruneConfigSubscriptions([])).toBe(0);
    expect(store.getSubscription("coder", "local:eng")?.source).toBe("agent");
  });

  it("keeps the cursor of a config row that survives a prune", () => {
    store.subscribe({ agent: "coder", roomRef: "local:eng", source: "config" });
    store.advanceCursor("coder", "local:eng", cursor(9));

    store.pruneConfigSubscriptions([{ agent: "coder", roomRef: "local:eng" }]);

    expect(store.getSubscription("coder", "local:eng")?.cursor).toBe(cursor(9));
  });
});

describe("RoomStore.subscribe — whose opinion wins", () => {
  let db: Database.Database;
  let store: RoomStore;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new RoomStore(db);
    store.upsertRoom(room("eng", "eng"));
  });

  afterEach(() => {
    db.close();
  });

  it("keeps a wake mode the agent chose when a later call has no opinion", () => {
    // `invite` and `create` have no wake mode to offer, but passed the default
    // anyway — so an agent that set itself to "all" was silently put back to
    // "named" the next time someone invited it to the room it was already in,
    // while the subscribe that set "all" had truthfully reported success.
    store.subscribe({ agent: "coder", roomRef: "local:eng", wakeOn: "all", source: "agent" });

    const after = store.subscribe({ agent: "coder", roomRef: "local:eng", source: "agent" });

    expect(after.wakeOn).toBe("all");
    expect(store.getSubscription("coder", "local:eng")?.wakeOn).toBe("all");
  });

  it("still applies a wake mode when one is actually named", () => {
    store.subscribe({ agent: "coder", roomRef: "local:eng", wakeOn: "all", source: "agent" });

    expect(store.subscribe({ agent: "coder", roomRef: "local:eng", wakeOn: "none", source: "agent" }).wakeOn).toBe(
      "none",
    );
  });

  it("uses the default for a seat that does not exist yet", () => {
    const fresh = store.subscribe({ agent: "reviewer", roomRef: "local:eng", source: "agent" });

    expect(fresh.wakeOn).toBe("addressed");
    expect(fresh.deliver).toBe("push");
  });

  it("preserves delivery the same way", () => {
    store.subscribe({ agent: "coder", roomRef: "local:eng", deliver: "poll", source: "agent" });

    expect(store.subscribe({ agent: "coder", roomRef: "local:eng", source: "agent" }).deliver).toBe("poll");
  });
});

describe("RoomStore cursors", () => {
  let db: Database.Database;
  let store: RoomStore;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new RoomStore(db);
    store.upsertRoom(room("eng", "eng"));
    store.subscribe({ agent: "coder", roomRef: "local:eng" });
  });

  afterEach(() => {
    db.close();
  });

  it("moves a null cursor forward", () => {
    store.advanceCursor("coder", "local:eng", cursor(5));
    expect(store.getSubscription("coder", "local:eng")?.cursor).toBe(cursor(5));
  });

  it("never moves a cursor backwards", () => {
    store.advanceCursor("coder", "local:eng", cursor(10));
    store.advanceCursor("coder", "local:eng", cursor(4));
    store.advanceCursor("coder", "local:eng", cursor(10));

    expect(store.getSubscription("coder", "local:eng")?.cursor).toBe(cursor(10));
  });

  it("compares cursors lexically, which is why backends zero-pad them", () => {
    store.advanceCursor("coder", "local:eng", cursor(9));
    store.advanceCursor("coder", "local:eng", cursor(10));

    expect(store.getSubscription("coder", "local:eng")?.cursor).toBe(cursor(10));
  });

  it("ignores an advance for an agent that is not subscribed", () => {
    expect(() => store.advanceCursor("ghost", "local:eng", cursor(3))).not.toThrow();
    expect(store.getSubscription("ghost", "local:eng")).toBeNull();
  });

  it("keeps a cursor per subscriber, not per room", () => {
    // Every subscriber reads at its own pace: advancing one must not mark the
    // traffic as seen for the others.
    store.subscribe({ agent: "supervisor", roomRef: "local:eng" });
    store.upsertRoom(room("ops", "ops"));
    store.subscribe({ agent: "coder", roomRef: "local:ops" });

    store.advanceCursor("coder", "local:eng", cursor(12));

    expect(store.getSubscription("coder", "local:eng")?.cursor).toBe(cursor(12));
    expect(store.getSubscription("supervisor", "local:eng")?.cursor).toBeNull();
    expect(store.getSubscription("coder", "local:ops")?.cursor).toBeNull();
  });
});

describe("RoomStore wake budget", () => {
  let db: Database.Database;
  let store: RoomStore;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new RoomStore(db);
    store.upsertRoom(room("eng", "eng"));
    store.subscribe({ agent: "coder", roomRef: "local:eng" });
  });

  afterEach(() => {
    db.close();
  });

  it("allows exactly maxPerHour wakes and then refuses", () => {
    const results = [1, 2, 3, 4].map(() => store.tryConsumeWake("coder", "local:eng", 3));

    expect(results).toEqual([true, true, true, false]);
    expect(store.getSubscription("coder", "local:eng")?.wakesThisHour).toBe(3);
  });

  it("records the bucket and the wake time on a granted wake", () => {
    expect(store.tryConsumeWake("coder", "local:eng", 1)).toBe(true);

    const sub = store.getSubscription("coder", "local:eng")!;
    const now = db.prepare("SELECT strftime('%Y-%m-%dT%H', 'now') AS b").get() as { b: string };
    expect(sub.hourBucket).toBe(now.b);
    expect(sub.lastWokeAt).toBeTruthy();
  });

  it("refuses every wake when the ceiling is zero, and records nothing", () => {
    expect(store.tryConsumeWake("coder", "local:eng", 0)).toBe(false);

    const sub = store.getSubscription("coder", "local:eng")!;
    expect(sub.wakesThisHour).toBe(0);
    expect(sub.lastWokeAt).toBeNull();
    expect(sub.hourBucket).toBeNull();
  });

  it("resets the allowance when the clock hour changes", () => {
    store.tryConsumeWake("coder", "local:eng", 2);
    store.tryConsumeWake("coder", "local:eng", 2);
    expect(store.tryConsumeWake("coder", "local:eng", 2)).toBe(false);

    // SQLite's own clock decides the bucket, so age the row rather than the clock.
    db.prepare("UPDATE room_subscriptions SET hour_bucket = strftime('%Y-%m-%dT%H', 'now', '-2 hours')").run();

    expect(store.tryConsumeWake("coder", "local:eng", 2)).toBe(true);
    expect(store.getSubscription("coder", "local:eng")?.wakesThisHour).toBe(1);
  });

  it("gives a wake back when the agent said nothing", () => {
    // The ceiling exists to stop two agents talking each other into the
    // ground, and what makes that expensive is replying. An agent that read
    // the room and had nothing to add has not moved the loop forward, but it
    // used to pay the same price — which is how a busy room went quiet for the
    // rest of the hour while traffic kept arriving.
    expect(store.tryConsumeWake("coder", "local:eng", 2)).toBe(true);
    store.refundWake("coder", "local:eng");

    expect(store.getSubscription("coder", "local:eng")?.wakesThisHour).toBe(0);
    expect(store.tryConsumeWake("coder", "local:eng", 2)).toBe(true);
    expect(store.tryConsumeWake("coder", "local:eng", 2)).toBe(true);
  });

  it("cannot mint budget by refunding more than was spent", () => {
    store.refundWake("coder", "local:eng");
    store.refundWake("coder", "local:eng");

    expect(store.getSubscription("coder", "local:eng")?.wakesThisHour).toBe(0);
    expect(store.tryConsumeWake("coder", "local:eng", 1)).toBe(true);
    expect(store.tryConsumeWake("coder", "local:eng", 1)).toBe(false);
  });

  it("does not refund across an hour boundary", () => {
    // The spend belonged to a bucket that has already been forgotten; crediting
    // it to the current one would hand out an extra wake every hour.
    store.tryConsumeWake("coder", "local:eng", 1);
    db.prepare("UPDATE room_subscriptions SET hour_bucket = strftime('%Y-%m-%dT%H', 'now', '-2 hours')").run();

    store.refundWake("coder", "local:eng");

    expect(store.getSubscription("coder", "local:eng")?.wakesThisHour).toBe(1);
  });

  it("budgets each (agent, room) pair separately", () => {
    store.upsertRoom(room("ops", "ops"));
    store.subscribe({ agent: "supervisor", roomRef: "local:eng" });
    store.subscribe({ agent: "coder", roomRef: "local:ops" });

    expect(store.tryConsumeWake("coder", "local:eng", 1)).toBe(true);
    expect(store.tryConsumeWake("coder", "local:eng", 1)).toBe(false);
    // A different agent in the same room, and the same agent in another room,
    // both still have their full allowance.
    expect(store.tryConsumeWake("supervisor", "local:eng", 1)).toBe(true);
    expect(store.tryConsumeWake("coder", "local:ops", 1)).toBe(true);
  });

  it("refuses a wake for an agent that is not subscribed", () => {
    expect(store.tryConsumeWake("ghost", "local:eng", 10)).toBe(false);
  });
});

describe("RoomStore members", () => {
  let db: Database.Database;
  let store: RoomStore;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new RoomStore(db);
    store.upsertRoom(room("eng", "eng"));
  });

  afterEach(() => {
    db.close();
  });

  it("upgrades a member in place rather than duplicating it", () => {
    store.putMember("local:eng", { id: "coder", label: "coder", kind: "unknown" });
    store.putMember("local:eng", { id: "coder", label: "Coder", kind: "agent" });

    expect(store.listMembers("local:eng")).toEqual([{ id: "coder", label: "Coder", kind: "agent" }]);
  });

  it("scopes membership to a room and sorts by label", () => {
    store.upsertRoom(room("ops", "ops"));
    store.putMember("local:eng", { id: "2", label: "zoe", kind: "human" });
    store.putMember("local:eng", { id: "1", label: "adam", kind: "human" });
    store.putMember("local:ops", { id: "3", label: "coder", kind: "agent" });

    expect(store.listMembers("local:eng").map((m) => m.label)).toEqual(["adam", "zoe"]);
    expect(store.listMembers("local:ops").map((m) => m.label)).toEqual(["coder"]);
  });

  it("falls back to kind 'unknown' for anything else stored in the column", () => {
    store.putMember("local:eng", { id: "1", label: "bot", kind: "agent" });
    db.prepare("UPDATE room_members SET kind = 'webhook'").run();

    expect(store.listMembers("local:eng")[0].kind).toBe("unknown");
  });

  it("reports whether a removal happened", () => {
    store.putMember("local:eng", { id: "coder", label: "coder", kind: "agent" });

    expect(store.removeMember("local:eng", "coder")).toBe(true);
    expect(store.removeMember("local:eng", "coder")).toBe(false);
  });
});

describe("RoomStore.repointRoom", () => {
  let db: Database.Database;
  let store: RoomStore;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new RoomStore(db);
    store.upsertRoom({ ref: { backend: "discord", id: "OLD" }, name: "eng", purpose: "t" });
    store.subscribe({ agent: "coder", roomRef: "discord:OLD", source: "config" });
    store.subscribe({ agent: "planner", roomRef: "discord:OLD", wakeOn: "all", source: "agent" });
    store.advanceCursor("coder", "discord:OLD", "0000000000000009");
    store.putMember("discord:OLD", { id: "u1", label: "alex", kind: "human" });
  });

  afterEach(() => db.close());

  it("carries the name, subscriptions and members to the new ref", () => {
    store.repointRoom("discord:OLD", { backend: "discord", id: "NEW" });

    expect(store.getRoomByName("eng")?.ref).toEqual({ backend: "discord", id: "NEW" });
    expect(store.getRoomByRef("discord:OLD")).toBeNull();
    expect(
      store
        .listSubscriptionsForRoom("discord:NEW")
        .map((s) => s.agent)
        .sort(),
    ).toEqual(["coder", "planner"]);
    // An agent-created subscription survives a config-driven re-point.
    expect(store.getSubscription("planner", "discord:NEW")?.wakeOn).toBe("all");
    expect(store.listMembers("discord:NEW").map((m) => m.label)).toEqual(["alex"]);
  });

  it("clears cursors, because a cursor only means something in its own channel", () => {
    store.repointRoom("discord:OLD", { backend: "discord", id: "NEW" });

    expect(store.getSubscription("coder", "discord:NEW")?.cursor).toBeNull();
  });

  it("is a no-op when the ref is unchanged", () => {
    store.advanceCursor("coder", "discord:OLD", "0000000000000009");
    store.repointRoom("discord:OLD", { backend: "discord", id: "OLD" });

    expect(store.getSubscription("coder", "discord:OLD")?.cursor).toBe("0000000000000009");
  });
});

describe("RoomStore conversation depth", () => {
  let db: Database.Database;
  let store: RoomStore;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new RoomStore(db);
    store.upsertRoom({ ref: { backend: "local", id: "eng" }, name: "eng" });
  });

  afterEach(() => db.close());

  it("counts consecutive agent turns and resets when a human speaks", () => {
    expect(store.noteRoomTurn("local:eng", false)).toBe(1);
    expect(store.noteRoomTurn("local:eng", false)).toBe(2);
    expect(store.noteRoomTurn("local:eng", false)).toBe(3);

    // A human arriving means the conversation is going somewhere.
    expect(store.noteRoomTurn("local:eng", true)).toBe(0);
    expect(store.agentTurns("local:eng")).toBe(0);

    expect(store.noteRoomTurn("local:eng", false)).toBe(1);
  });

  it("keeps the count per room", () => {
    store.upsertRoom({ ref: { backend: "local", id: "ops" }, name: "ops" });

    store.noteRoomTurn("local:eng", false);
    store.noteRoomTurn("local:eng", false);

    expect(store.agentTurns("local:eng")).toBe(2);
    expect(store.agentTurns("local:ops")).toBe(0);
  });

  it("reports zero for a room it has never seen rather than throwing", () => {
    expect(store.agentTurns("local:nope")).toBe(0);
  });
});

describe("extractLeadingAddressees", () => {
  const known = (l: string) => ["coder", "planner", "alex"].includes(l.toLowerCase());

  it("lifts the bracketed form the format asks for", () => {
    expect(extractLeadingAddressees("<coder> on it", known)).toEqual({ to: ["coder"], body: "on it" });
  });

  it("lifts a bare name that repeats what we are already stamping", () => {
    // The observed bug: core stamps <coder>, the model also writes "coder",
    // and Discord shows "[planner] <coder> coder Copy that."
    expect(extractLeadingAddressees("coder Copy that.", known, ["coder"])).toEqual({
      to: ["coder"],
      body: "Copy that.",
    });
  });

  it("lifts a punctuated bare name even when nobody was stamped", () => {
    expect(extractLeadingAddressees("planner, queue is clear", known)).toEqual({
      to: ["planner"],
      body: "queue is clear",
    });
  });

  it("leaves an unpunctuated name alone when it is not a repeat, because it is probably the subject", () => {
    // Stripping here would turn "coder should look at this" into "should look
    // at this", which says something different.
    expect(extractLeadingAddressees("coder should look at this", known)).toEqual({
      to: [],
      body: "coder should look at this",
    });
  });

  it("ignores names nobody knows", () => {
    expect(extractLeadingAddressees("nobody, hello", known)).toEqual({ to: [], body: "nobody, hello" });
  });

  it("takes several addressees and dedupes case-insensitively", () => {
    expect(extractLeadingAddressees("<coder> <Coder> <planner> go", known)).toEqual({
      to: ["coder", "planner"],
      body: "go",
    });
  });

  it("leaves an ordinary body untouched", () => {
    expect(extractLeadingAddressees("the deploy finished", known)).toEqual({
      to: [],
      body: "the deploy finished",
    });
  });
});

describe("RoomStore webhooks", () => {
  let db: Database.Database;
  let store: RoomStore;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new RoomStore(db);
    store.upsertRoom({ ref: { backend: "discord", id: "C1" }, name: "eng" });
    store.upsertRoom({ ref: { backend: "discord", id: "C2" }, name: "ops" });
  });

  afterEach(() => db.close());

  it("round-trips a credential and reports none until one is set", () => {
    expect(store.getWebhook("discord:C1")).toBeNull();

    store.setWebhook("discord:C1", { id: "W1", token: "t0k3n" });

    expect(store.getWebhook("discord:C1")).toEqual({ id: "W1", token: "t0k3n" });
    expect(store.getWebhook("discord:C2")).toBeNull();
  });

  it("lists every webhook id we own, which is what tells our posts from a foreign webhook", () => {
    store.setWebhook("discord:C1", { id: "W1", token: "a" });
    store.setWebhook("discord:C2", { id: "W2", token: "b" });

    expect(store.knownWebhookIds()).toEqual(new Set(["W1", "W2"]));
    // A webhook we did not create must not be in the set — otherwise anyone
    // with a webhook could post `username: "planner"` and be believed.
    expect(store.knownWebhookIds().has("W-someone-else")).toBe(false);
  });

  it("clears a credential without dropping the room", () => {
    store.setWebhook("discord:C1", { id: "W1", token: "a" });
    store.setWebhook("discord:C1", null);

    expect(store.getWebhook("discord:C1")).toBeNull();
    expect(store.getRoomByName("eng")).not.toBeNull();
    expect(store.knownWebhookIds().size).toBe(0);
  });

  it("treats a half-written credential as absent rather than returning a broken one", () => {
    db.prepare("UPDATE rooms SET webhook_id = 'W1', webhook_token = NULL WHERE ref = 'discord:C1'").run();

    expect(store.getWebhook("discord:C1")).toBeNull();
  });
});

describe("the @name addressing form", () => {
  const known = (l: string) => ["coder", "planner", "alex"].includes(l.toLowerCase());

  it("emits @name, not the bracketed form", () => {
    expect(formatEnvelope({ speaker: "planner", to: ["coder"], body: "ready?" })).toBe("[planner] @coder ready?");
  });

  it("still reads the <name> form rooms used before, so old messages keep parsing", () => {
    expect(parseEnvelope("[planner] <coder> old message", known)).toEqual({
      speaker: "planner",
      to: ["coder"],
      body: "old message",
    });
  });

  it("reads a mix of both forms", () => {
    expect(parseEnvelope("[planner] @coder <alex> look", known)).toEqual({
      speaker: "planner",
      to: ["coder", "alex"],
      body: "look",
    });
  });

  it("never treats @everyone or @here as an addressee", () => {
    // These are the one Discord mention form that is live in raw content and
    // takes no brackets, so they are the whole reason send paths also pass
    // allowedMentions: { parse: [] }.
    expect(parseEnvelope("@everyone heads up", known)).toEqual({
      speaker: undefined,
      to: [],
      body: "@everyone heads up",
    });
    expect(parseEnvelope("@here standup", known)).toEqual({
      speaker: undefined,
      to: [],
      body: "@here standup",
    });
  });

  it("leaves Discord's own mention syntax alone", () => {
    // <@123> user, <@&1> role, <#1> channel, <:x:1> emoji — all reserved, none
    // of them an identity label.
    for (const raw of ["<@123456> hello", "<@&998877> hello", "<#1467> hello", "<:tada:1> hello"]) {
      expect(parseEnvelope(raw, known).to).toEqual([]);
      expect(parseEnvelope(raw, known).body).toBe(raw);
    }
  });

  it("does not mistake an email address for an addressee", () => {
    expect(extractLeadingAddressees("mail foo@bar.com when ready", known)).toEqual({
      to: [],
      body: "mail foo@bar.com when ready",
    });
  });

  it("escapes a body that itself opens with @name, and unescapes on the way back", () => {
    const wire = formatEnvelope({ speaker: "planner", to: [], body: "@coder should own this" });

    expect(wire).toBe("[planner] \\@coder should own this");
    expect(parseEnvelope(wire, known)).toEqual({
      speaker: "planner",
      to: [],
      body: "@coder should own this",
    });
  });

  it("lifts @name out of a reply body", () => {
    expect(extractLeadingAddressees("@planner on it", known)).toEqual({
      to: ["planner"],
      body: "on it",
    });
  });
});

describe("addressing a real account", () => {
  const known = (l: string) => ["coder", "planner", "alex"].includes(l.toLowerCase());
  const OWNER = "111111111111111111";
  // What the Discord backend supplies: humans have an account, agents don't.
  const render = (label: string) => (label === "alex" ? `<@${OWNER}>` : `@${label}`);

  it("renders a human as a real mention and an agent as plain text", () => {
    const wire = formatEnvelope({
      speaker: "planner",
      to: ["coder", "alex"],
      body: "need a decision here",
      renderAddressee: render,
    });

    // The human gets a mention Discord will actually notify on; the agent has
    // no account to mention and is woken by the watcher instead.
    expect(wire).toBe(`[planner] @coder <@${OWNER}> need a decision here`);
  });

  it("still writes plain @name when no renderer is supplied", () => {
    expect(formatEnvelope({ speaker: "planner", to: ["alex"], body: "hi" })).toBe("[planner] @alex hi");
  });

  it("round-trips: a rendered mention resolves back to its label", () => {
    const wire = formatEnvelope({
      speaker: "planner",
      to: ["coder", "alex"],
      body: "need a decision here",
      renderAddressee: render,
    });

    // What the Discord backend does on the way back in, before parsing.
    const resolved = wire.replace(/<@!?(\d+)>/g, (whole, id) => (id === OWNER ? "@alex" : whole));

    expect(parseEnvelope(resolved, known)).toEqual({
      speaker: "planner",
      to: ["coder", "alex"],
      body: "need a decision here",
    });
  });

  it("leaves an unrecognised account mention as-is rather than inventing a label", () => {
    const raw = "[planner] <@999999999999> take a look";
    const resolved = raw.replace(/<@!?(\d+)>/g, (whole, id) => (id === OWNER ? "@alex" : whole));

    expect(resolved).toBe(raw);
    // Unresolvable, so it stays body text — never a phantom addressee.
    expect(parseEnvelope(resolved, known).to).toEqual([]);
  });
});

describe("addressing that nearly worked", () => {
  const known = (l: string) => ["default", "channel-manager", "coder"].includes(l.toLowerCase());

  it("resolves a qualified name people actually type", () => {
    // "@agent:channel-manager hello" used to parse as NOTHING, which turned a
    // message meant for one agent into an unaddressed broadcast that woke
    // every agent in the room.
    expect(parseEnvelope("@agent:channel-manager hello", known)).toEqual({
      speaker: undefined,
      to: ["channel-manager"],
      body: "hello",
    });
  });

  it("resolves any qualifier, not just 'agent'", () => {
    expect(parseEnvelope("@bot:coder ping", known).to).toEqual(["coder"]);
  });

  it("still ignores a qualified name for somebody who does not exist", () => {
    // A typo must not resolve to something plausible-looking.
    expect(parseEnvelope("@agent:nobody hello", known)).toEqual({
      speaker: undefined,
      to: [],
      body: "@agent:nobody hello",
    });
  });

  it("prefers an exact match over the trailing segment", () => {
    const weird = (l: string) => l === "a:b";
    expect(parseEnvelope("@a:b hi", weird).to).toEqual(["a:b"]);
  });

  it("leaves @everyone alone even with the looser charset", () => {
    expect(parseEnvelope("@everyone: standup", known).to).toEqual([]);
  });

  it("lifts a qualified name out of a reply body too", () => {
    expect(extractLeadingAddressees("@agent:coder on it", known)).toEqual({
      to: ["coder"],
      body: "on it",
    });
  });
});

describe("mentions anywhere in a message", () => {
  const known = (l: string) => ["coder", "generalist", "alex"].includes(l.toLowerCase());

  it("finds a call-out made mid-sentence", () => {
    // The real case: "Done. Created list_directory. @generalist you're up" —
    // formally addressed to Alex, but generalist is clearly being paged.
    expect(mentionsIn("Done, added the tool. @generalist you're up to test it", known)).toEqual(["generalist"]);
  });

  it("finds several, deduped, and ignores unknown names", () => {
    expect(mentionsIn("@coder and @generalist — not @nobody", known)).toEqual(["coder", "generalist"]);
  });

  it("resolves qualified mentions mid-body", () => {
    expect(mentionsIn("handing to @agent:coder now", known)).toEqual(["coder"]);
  });

  it("strips trailing punctuation from a mention", () => {
    expect(mentionsIn("over to you, @coder.", known)).toEqual(["coder"]);
  });

  it("does not treat an email address or @everyone as a mention", () => {
    expect(mentionsIn("mail foo@bar.com and tell @everyone", known)).toEqual([]);
  });
});

describe("depth cap versus real work", () => {
  let db: Database.Database;
  let store: RoomStore;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new RoomStore(db);
    store.upsertRoom({ ref: { backend: "local", id: "eng" }, name: "eng" });
  });

  afterEach(() => db.close());

  it("clears the count when a turn did real work", () => {
    // Two agents collaborating look exactly like two agents being polite —
    // both are "agents talking without a human". Tool use is what tells them
    // apart, and silencing a working pair mid-task is the worse failure.
    store.noteRoomTurn("local:eng", false);
    store.noteRoomTurn("local:eng", false);
    store.noteRoomTurn("local:eng", false);
    expect(store.agentTurns("local:eng")).toBe(3);

    store.resetAgentTurns("local:eng");

    expect(store.agentTurns("local:eng")).toBe(0);
  });

  it("still climbs for turns that only talk", () => {
    for (let i = 0; i < 4; i += 1) store.noteRoomTurn("local:eng", false);

    expect(store.agentTurns("local:eng")).toBe(4);
  });

  it("does not throw for a room it has never seen", () => {
    expect(() => store.resetAgentTurns("local:nope")).not.toThrow();
  });
});

describe("a turn is a speaker run, not a message", () => {
  let db: Database.Database;
  let store: RoomStore;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new RoomStore(db);
    store.upsertRoom({ ref: { backend: "local", id: "eng" }, name: "eng" });
  });

  afterEach(() => db.close());

  it("counts one long reply split across messages as a single turn", () => {
    // Discord splits anything past 2000 characters. Counting messages made one
    // answer look like three turns and tripped the depth cap mid-sentence.
    expect(store.noteRoomTurn("local:eng", false, "researcher")).toBe(1);
    expect(store.noteRoomTurn("local:eng", false, "researcher")).toBe(1);
    expect(store.noteRoomTurn("local:eng", false, "researcher")).toBe(1);
  });

  it("counts a new speaker as a new turn", () => {
    store.noteRoomTurn("local:eng", false, "researcher");
    store.noteRoomTurn("local:eng", false, "researcher");

    expect(store.noteRoomTurn("local:eng", false, "coordinator")).toBe(2);
    expect(store.noteRoomTurn("local:eng", false, "researcher")).toBe(3);
  });

  it("still resets on a human, and their turn does not count", () => {
    store.noteRoomTurn("local:eng", false, "researcher");
    store.noteRoomTurn("local:eng", false, "coordinator");

    expect(store.noteRoomTurn("local:eng", true, "alex")).toBe(0);
    // The next agent message starts a fresh run rather than continuing one.
    expect(store.noteRoomTurn("local:eng", false, "researcher")).toBe(1);
  });

  it("counts each message when no speaker can be resolved", () => {
    // Unattributed traffic has no run to belong to; counting is the safe side.
    expect(store.noteRoomTurn("local:eng", false)).toBe(1);
    expect(store.noteRoomTurn("local:eng", false)).toBe(2);
  });
});

describe("looksLikeUninvokedPass", () => {
  it("recognises a written-out pass call, with or without an addressee", () => {
    expect(looksLikeUninvokedPass('@travel-coordinator room(action="pass")')).toBe(true);
    expect(looksLikeUninvokedPass("room(action=pass)")).toBe(true);
    expect(looksLikeUninvokedPass('`room(action="pass")`')).toBe(true);
  });

  it("leaves a real message alone even when it talks about passing", () => {
    expect(looksLikeUninvokedPass("I will pass on this one")).toBe(false);
    expect(looksLikeUninvokedPass('Passing to @coder — room(action="pass") is what I would call')).toBe(false);
    expect(looksLikeUninvokedPass('room(action="post")')).toBe(false);
  });
});

describe("a misspelt addressee", () => {
  const names = ["default", "travel-coordinator", "travel-researcher", "booking-tracker", "alex"];
  const known = (l: string) => names.includes(l.toLowerCase());
  const candidates = () => names;

  it("corrects a near-miss to the one identity it can only mean", () => {
    // Unresolved counts as unaddressed, which routes to whoever hosts the
    // room — so a typo hands your request to the wrong agent and answers it,
    // with nothing to indicate anything went wrong.
    expect(parseEnvelope("@travel-coordinaror do the itinerary", known, candidates).to).toEqual(["travel-coordinator"]);
    expect(parseEnvelope("@bookng-tracker status", known, candidates).to).toEqual(["booking-tracker"]);
  });

  it("refuses to guess when two identities are equally close", () => {
    // "travel-cooordinator" vs "travel-researcher" — guessing an addressee is
    // how you hand someone's request to the wrong agent deliberately.
    const twins = ["alpha-one", "alpha-two"];
    const near = parseEnvelope(
      "@alpha-onx hi",
      (l) => twins.includes(l),
      () => twins,
    );
    expect(near.to).toEqual(["alpha-one"]);

    const ambiguous = parseEnvelope(
      "@alpha-tno hi",
      (l) => twins.includes(l),
      () => twins,
    );
    expect(ambiguous.to).toEqual([]);
  });

  it("leaves short or unrelated tokens alone", () => {
    expect(parseEnvelope("@xyz hello", known, candidates).to).toEqual([]);
    expect(parseEnvelope("@everyone hello", known, candidates).to).toEqual([]);
    expect(parseEnvelope("@bob hello", known, candidates).to).toEqual([]);
  });

  it("prefers an exact match over any correction", () => {
    expect(parseEnvelope("@default hi", known, candidates).to).toEqual(["default"]);
  });

  it("corrects nothing when no candidate list is supplied", () => {
    expect(parseEnvelope("@travel-coordinaror hi", known).to).toEqual([]);
  });
});

describe("describeToolCall", () => {
  it("names the tool and what it acted on", () => {
    expect(describeToolCall("read", { path: "/home/q/trip/itinerary.md" })).toBe("`read` /home/q/trip/itinerary.md");
    expect(describeToolCall("web_search", { query: "san diego tiki bars" })).toBe("`web_search` san diego tiki bars");
  });

  it("does not leak the payload — only what identifies the target", () => {
    // Full arguments would put file contents and search bodies in a channel.
    const line = describeToolCall("write", {
      path: "/home/q/trip/notes.md",
      content: "SECRET CONTENT that must not appear",
    });

    expect(line).toContain("/home/q/trip/notes.md");
    expect(line).not.toContain("SECRET");
  });

  it("truncates a very long target", () => {
    expect(describeToolCall("read", { path: "/x/".repeat(200) }).length).toBeLessThan(140);
  });

  it("falls back to the bare name when nothing identifies a target", () => {
    expect(describeToolCall("current_datetime", {})).toBe("`current_datetime`");
  });
});

describe("per-room roles and quiet posting", () => {
  let db: Database.Database;
  let store: RoomStore;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new RoomStore(db);
    store.upsertRoom({ ref: { backend: "local", id: "eng" }, name: "eng" });
  });

  afterEach(() => db.close());

  it("keeps a role per subscription, not per agent", () => {
    // The same agent should behave differently in two rooms; only its global
    // instructions existed before.
    store.upsertRoom({ ref: { backend: "local", id: "trip" }, name: "trip" });
    store.subscribe({ agent: "coordinator", roomRef: "local:eng", role: "review code changes" });
    store.subscribe({ agent: "coordinator", roomRef: "local:trip", role: "keep the itinerary current" });

    expect(store.getSubscription("coordinator", "local:eng")?.role).toBe("review code changes");
    expect(store.getSubscription("coordinator", "local:trip")?.role).toBe("keep the itinerary current");
  });

  it("keeps an existing role when re-subscribing without one", () => {
    // A config reconcile must not silently strip an agent's role.
    store.subscribe({ agent: "coder", roomRef: "local:eng", role: "implement" });
    store.subscribe({ agent: "coder", roomRef: "local:eng", wakeOn: "all" });

    const sub = store.getSubscription("coder", "local:eng");
    expect(sub?.role).toBe("implement");
    expect(sub?.wakeOn).toBe("all");
  });

  it("leaves the role unset when nobody asked for one", () => {
    store.subscribe({ agent: "coder", roomRef: "local:eng" });

    expect(store.getSubscription("coder", "local:eng")?.role).toBeNull();
  });
});

// ---------------------------------------------------------------- archiving

describe("RoomStore archiving", () => {
  let db: Database.Database;
  let store: RoomStore;

  const refOf = (room: Room): string => `${room.ref.backend}:${room.ref.id}`;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new RoomStore(db);
    store.upsertRoom({ ref: { backend: "local", id: "trip-1" }, name: "trip" });
  });
  afterEach(() => db.close());

  it("hides an archived room from listRooms but keeps it readable by ref", () => {
    store.archiveRoom("local:trip-1", { by: "alex", reason: "trip is over" });

    expect(store.listRooms().map((r) => r.name)).toEqual([]);
    expect(store.listArchivedRooms().map((r) => r.name)).toEqual(["trip"]);

    const room = store.getRoomByRef("local:trip-1");
    expect(room?.archivedAt).toBeTruthy();
    expect(room?.archivedBy).toBe("alex");
    expect(room?.archiveReason).toBe("trip is over");
  });

  it("keeps every subscription, cursor and cadence so unarchiving restores the room", () => {
    store.subscribe({ agent: "coordinator", roomRef: "local:trip-1", wakeOn: "all", checkInMinutes: 60 });
    store.advanceCursor("coordinator", "local:trip-1", "0000000000000000042");

    store.archiveRoom("local:trip-1");

    // The seat is untouched — this is the whole difference from removeRoom.
    const sub = store.getSubscription("coordinator", "local:trip-1");
    expect(sub?.wakeOn).toBe("all");
    expect(sub?.checkInMinutes).toBe(60);
    expect(sub?.cursor).toBe("0000000000000000042");

    // ...but it is no longer something the watcher would arm.
    expect(store.listActiveSubscriptions()).toEqual([]);
    expect(store.listSubscriptions()).toHaveLength(1);

    store.unarchiveRoom("local:trip-1");
    expect(store.listActiveSubscriptions()).toHaveLength(1);
  });

  it("releases the name, so the next room can take it", () => {
    store.archiveRoom("local:trip-1");

    // The reason archiving exists at all: opening the next trip room.
    expect(() => store.upsertRoom({ ref: { backend: "local", id: "trip-2" }, name: "trip" })).not.toThrow();
    expect(store.listRooms().map(refOf)).toEqual(["local:trip-2"]);
  });

  it("still refuses two LIVE rooms under one name", () => {
    expect(() => store.upsertRoom({ ref: { backend: "local", id: "trip-2" }, name: "trip" })).toThrow(
      /already used by local:trip-1/,
    );
  });

  it("resolves a name to the live room, never the archived namesake", () => {
    store.archiveRoom("local:trip-1");
    store.upsertRoom({ ref: { backend: "local", id: "trip-2" }, name: "trip" });

    // Without the ordering this is a coin flip, and half the posts would land
    // in the retired room.
    expect(store.getRoomByName("trip")?.ref.id).toBe("trip-2");
    expect(store.resolve("trip")?.ref.id).toBe("trip-2");
    // The archived one is still reachable by its own ref.
    expect(store.getRoomByRef("local:trip-1")?.archivedAt).toBeTruthy();
  });

  it("refuses to unarchive when the name has been taken since", () => {
    store.archiveRoom("local:trip-1");
    store.upsertRoom({ ref: { backend: "local", id: "trip-2" }, name: "trip" });

    expect(() => store.unarchiveRoom("local:trip-1")).toThrow(/now belongs to local:trip-2/);
    // And it stays archived rather than half-restored.
    expect(store.getRoomByRef("local:trip-1")?.archivedAt).toBeTruthy();
  });

  it("is idempotent, so a config reconcile cannot keep re-stamping the timestamp", () => {
    expect(store.archiveRoom("local:trip-1", { reason: "done" })).not.toBeNull();

    // A second archive changes nothing and reports that it did nothing, which
    // is what stops reconcileRooms re-announcing on every reload.
    expect(store.archiveRoom("local:trip-1", { reason: "done again" })).toBeNull();
    expect(store.getRoomByRef("local:trip-1")?.archiveReason).toBe("done");
  });

  it("emits room.archived and room.unarchived, not membership changes", () => {
    const events: string[] = [];
    const bus = new TypedEventBus();
    for (const name of ["room.archived", "room.unarchived", "room.membership_changed"] as const) {
      bus.on(name, () => events.push(name));
    }
    const wired = new RoomStore(db, bus);
    wired.subscribe({ agent: "coordinator", roomRef: "local:trip-1" });
    events.length = 0;

    wired.archiveRoom("local:trip-1");
    wired.unarchiveRoom("local:trip-1");

    // Nobody joined and nobody left — the seats are exactly as they were.
    expect(events).toEqual(["room.archived", "room.unarchived"]);
  });

  it("reports unarchiving a room that was not archived as a no-op", () => {
    expect(store.unarchiveRoom("local:trip-1")).toBeNull();
  });

  it("keeps subscriptions whose room has no directory row at all", () => {
    // A ref can be subscribed before its room is registered: config declares
    // the subscription, the transport registers the room later. Treating
    // "unknown" as "archived" would silently unsubscribe those agents.
    store.subscribe({ agent: "coder", roomRef: "discord:not-registered-yet" });

    expect(store.listActiveSubscriptions().map((s) => s.roomRef)).toContain("discord:not-registered-yet");
  });
});

describe("archive migration on a database that predates it", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tai-rooms-archive-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("adds the columns and replaces the unconditional unique index", () => {
    const path = join(dir, "agent.db");

    // A database as it looked before archiving existed: no archived_at, and a
    // name index that is unique across ALL rooms.
    const old = new SQLite(path);
    old.exec(`
      CREATE TABLE rooms (
        ref TEXT PRIMARY KEY, backend TEXT NOT NULL, native_id TEXT NOT NULL,
        name TEXT NOT NULL, purpose TEXT, created_by TEXT,
        agent_turns INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX idx_rooms_name ON rooms(name);
    `);
    old
      .prepare("INSERT INTO rooms (ref, backend, native_id, name) VALUES (?, ?, ?, ?)")
      .run("local:trip-1", "local", "trip-1", "trip");
    old.close();

    const db = initDatabase(path);
    try {
      // The old index is a constraint, so leaving it beside the new one would
      // go on rejecting the name reuse this whole feature exists to allow —
      // while the partial index sat there looking like it had taken effect.
      const indexes = (db.prepare("PRAGMA index_list(rooms)").all() as Array<{ name: string }>).map((r) => r.name);
      expect(indexes).toContain("idx_rooms_name_active");
      expect(indexes).not.toContain("idx_rooms_name");

      const store = new RoomStore(db);
      expect(store.getRoomByName("trip")?.archivedAt).toBeUndefined();

      store.archiveRoom("local:trip-1");
      expect(() => store.upsertRoom({ ref: { backend: "local", id: "trip-2" }, name: "trip" })).not.toThrow();
    } finally {
      db.close();
    }
  });
});
