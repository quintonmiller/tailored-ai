/**
 * Filing archived rooms under a Discord category.
 *
 * The transport step is cosmetic and best-effort — TAI's archive is complete
 * without it — so the tests that matter are the ones about NOT doing damage on
 * the way past: not resyncing permissions, not clobbering the remembered
 * parent, not moving a channel we never moved.
 *
 * discord.js is doubled rather than run: `setParent` and category creation are
 * the whole surface, and asserting on the options passed to them is exactly the
 * thing that would otherwise only be observable in a live guild.
 */

import type Database from "better-sqlite3";
import { ChannelType, Collection } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordRoomBackend } from "../channels/discord-rooms.js";
import { initDatabase } from "../db/schema.js";
import { TypedEventBus } from "../events.js";
import { registerRoomBackend, unregisterRoomBackend } from "../rooms/registry.js";
import { RoomStore } from "../rooms/store.js";
import { RoomWatcher } from "../rooms/watcher.js";
import type { AgentRuntime } from "../runtime.js";

let db: Database.Database;
let store: RoomStore;

const CHANNEL_ID = "555";
const REF = `discord:${CHANNEL_ID}`;

interface FakeChannel {
  id: string;
  name: string;
  type: number;
  parentId: string | null;
  guild: FakeGuild;
  setParent: ReturnType<typeof vi.fn>;
}

interface FakeGuild {
  channels: {
    // A real discord.js Collection, not a Map: the lookup uses `.find`, which
    // only Collection has, and a shim that happened to expose one would not
    // prove the production call works.
    cache: Collection<string, { id: string; name: string; type: number }>;
    create: ReturnType<typeof vi.fn>;
  };
}

/** A guild holding `categories`, plus one text channel under `parentId`. */
function makeGuildAndChannel(categories: string[], parentId: string | null = null) {
  const cache = new Collection<string, { id: string; name: string; type: number }>();
  categories.forEach((name, i) => {
    cache.set(`cat-${i}`, { id: `cat-${i}`, name, type: ChannelType.GuildCategory });
  });

  const guild: FakeGuild = {
    channels: {
      cache,
      create: vi.fn(async ({ name, type }: { name: string; type: number }) => {
        const created = { id: `cat-new`, name, type };
        cache.set(created.id, created);
        return created;
      }),
    },
  };

  const channel: FakeChannel = {
    id: CHANNEL_ID,
    name: "trip",
    type: ChannelType.GuildText,
    parentId,
    guild,
    setParent: vi.fn(async function (this: void, next: string | null) {
      channel.parentId = next;
    }),
  };
  return { guild, channel };
}

function makeBackend(channel: FakeChannel, archiveCategory?: string): DiscordRoomBackend {
  const client = { channels: { fetch: async () => channel } };
  // biome-ignore lint/suspicious/noExplicitAny: hand-built discord.js double
  return new DiscordRoomBackend(client as any, { store, archiveCategory });
}

beforeEach(() => {
  db = initDatabase(":memory:");
  store = new RoomStore(db);
  store.upsertRoom({ ref: { backend: "discord", id: CHANNEL_ID }, name: "trip" });
});

afterEach(() => db.close());

describe("DiscordRoomBackend archive capability", () => {
  it("is false until a category is named", () => {
    const { channel } = makeGuildAndChannel([]);
    expect(makeBackend(channel).capabilities.archive).toBe(false);
    expect(makeBackend(channel, "   ").capabilities.archive).toBe(false);
  });

  it("is true once one is", () => {
    const { channel } = makeGuildAndChannel([]);
    expect(makeBackend(channel, "Archived").capabilities.archive).toBe(true);
  });

  it("does nothing at all when unconfigured", async () => {
    const { channel } = makeGuildAndChannel(["Archived"]);
    await makeBackend(channel).archiveRoom(CHANNEL_ID, true);

    expect(channel.setParent).not.toHaveBeenCalled();
  });
});

describe("DiscordRoomBackend.archiveRoom", () => {
  it("creates the category on first use and files the channel under it", async () => {
    const { guild, channel } = makeGuildAndChannel([]);
    await makeBackend(channel, "Archived").archiveRoom(CHANNEL_ID, true);

    expect(guild.channels.create).toHaveBeenCalledWith({ name: "Archived", type: ChannelType.GuildCategory });
    expect(channel.parentId).toBe("cat-new");
  });

  it("reuses an existing category, matched case-insensitively", async () => {
    const { guild, channel } = makeGuildAndChannel(["archived"]);
    await makeBackend(channel, "Archived").archiveRoom(CHANNEL_ID, true);

    // A second "Archived" category next to the user's own "archived" is the
    // kind of mess nobody notices until the sidebar has two of everything.
    expect(guild.channels.create).not.toHaveBeenCalled();
    expect(channel.parentId).toBe("cat-0");
  });

  it("moves WITHOUT resyncing permissions", async () => {
    const { channel } = makeGuildAndChannel(["Archived"]);
    await makeBackend(channel, "Archived").archiveRoom(CHANNEL_ID, true);

    // discord.js defaults lockPermissions to true, which would sync the
    // channel's overwrites to the archive category. Membership here is DERIVED
    // from those overwrites, so the default would not merely change who can
    // see a private room — it would erase the room's roster as a side effect of
    // tidying the sidebar.
    expect(channel.setParent).toHaveBeenCalledWith("cat-0", { lockPermissions: false });
  });

  it("puts the channel back in its original category on restore", async () => {
    const { channel } = makeGuildAndChannel(["Archived", "Travel"], "cat-1");
    const backend = makeBackend(channel, "Archived");

    await backend.archiveRoom(CHANNEL_ID, true);
    expect(channel.parentId).toBe("cat-0");

    await backend.archiveRoom(CHANNEL_ID, false);
    expect(channel.parentId).toBe("cat-1");
    // The note is spent, so a later unrelated move is not undone by it.
    expect(store.getBackendState(REF)).toBeNull();
  });

  it("restores a channel that had no category to no category", async () => {
    const { channel } = makeGuildAndChannel(["Archived"], null);
    const backend = makeBackend(channel, "Archived");

    await backend.archiveRoom(CHANNEL_ID, true);
    await backend.archiveRoom(CHANNEL_ID, false);

    // "It was top-level" has to survive as a real value; recorded as absent it
    // would be indistinguishable from "we never moved this".
    expect(channel.parentId).toBeNull();
    expect(channel.setParent).toHaveBeenLastCalledWith(null, { lockPermissions: false });
  });

  it("does not re-file a channel that is already archived", async () => {
    const { channel } = makeGuildAndChannel(["Archived", "Travel"], "cat-1");
    const backend = makeBackend(channel, "Archived");

    await backend.archiveRoom(CHANNEL_ID, true);
    await backend.archiveRoom(CHANNEL_ID, true);

    // The second call must not record the archive category as the "previous"
    // one, or restoring would leave the channel exactly where it started.
    expect(store.getBackendState(REF)).toEqual({ previousParentId: "cat-1" });
    await backend.archiveRoom(CHANNEL_ID, false);
    expect(channel.parentId).toBe("cat-1");
  });

  it("leaves a channel alone when restoring one it never moved", async () => {
    const { channel } = makeGuildAndChannel(["Archived"], "cat-0");
    await makeBackend(channel, "Archived").archiveRoom(CHANNEL_ID, false);

    // Someone may have filed this here themselves. Guessing a parent would move
    // another person's channel on no evidence.
    expect(channel.setParent).not.toHaveBeenCalled();
  });
});

describe("the watcher telling the transport", () => {
  afterEach(() => {
    unregisterRoomBackend("stub");
  });

  /** A backend that records archiveRoom calls, and can be made to fail. */
  function stubBackend(opts: { archive: boolean; throws?: boolean }) {
    const calls: Array<{ id: string; archived: boolean }> = [];
    const backend = {
      id: "stub",
      capabilities: { archive: opts.archive } as never,
      listRooms: async () => [],
      getRoom: async () => null,
      post: async () => null,
      fetchSince: async () => [],
      archiveRoom: async (id: string, archived: boolean) => {
        calls.push({ id, archived });
        if (opts.throws) throw new Error("Missing Permissions");
      },
    };
    registerRoomBackend(backend as never);
    return calls;
  }

  function startedWatcher(bus: TypedEventBus, wired: RoomStore): RoomWatcher {
    const watcher = new RoomWatcher({
      runtime: {
        getConfig: () => ({ agents: { coder: {} } }),
        getOwnerId: () => undefined,
        events: bus,
      } as unknown as AgentRuntime,
      store: wired,
    });
    watcher.start();
    return watcher;
  }

  it("files the room on archive and restores it on unarchive", async () => {
    const calls = stubBackend({ archive: true });
    const bus = new TypedEventBus();
    const wired = new RoomStore(db, bus);
    wired.upsertRoom({ ref: { backend: "stub", id: "trip" }, name: "stub-trip" });
    const watcher = startedWatcher(bus, wired);

    wired.archiveRoom("stub:trip");
    wired.unarchiveRoom("stub:trip");
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    expect(calls).toEqual([
      { id: "trip", archived: true },
      { id: "trip", archived: false },
    ]);
    watcher.stop();
  });

  it("skips a backend that reports it cannot", async () => {
    const calls = stubBackend({ archive: false });
    const bus = new TypedEventBus();
    const wired = new RoomStore(db, bus);
    wired.upsertRoom({ ref: { backend: "stub", id: "trip" }, name: "stub-trip" });
    const watcher = startedWatcher(bus, wired);

    wired.archiveRoom("stub:trip");
    await new Promise((r) => setImmediate(r));

    expect(calls).toEqual([]);
    watcher.stop();
  });

  it("keeps the room archived when the transport refuses", async () => {
    stubBackend({ archive: true, throws: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bus = new TypedEventBus();
    const wired = new RoomStore(db, bus);
    wired.upsertRoom({ ref: { backend: "stub", id: "trip" }, name: "stub-trip" });
    const watcher = startedWatcher(bus, wired);

    wired.archiveRoom("stub:trip");
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());

    // Tidying the sidebar is cosmetic. A bot without Manage Channels must not
    // turn a successful archive into a failed one.
    expect(wired.getRoomByRef("stub:trip")?.archivedAt).toBeTruthy();
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/still archived in TAI/);
    watcher.stop();
  });
});

describe("RoomStore backend state", () => {
  it("round-trips opaque JSON and clears on null", () => {
    store.setBackendState(REF, { previousParentId: "cat-1", anything: 3 });
    expect(store.getBackendState(REF)).toEqual({ previousParentId: "cat-1", anything: 3 });

    store.setBackendState(REF, null);
    expect(store.getBackendState(REF)).toBeNull();
  });

  it("reads malformed JSON as absent rather than throwing", () => {
    db.prepare("UPDATE rooms SET backend_state = ? WHERE ref = ?").run("{not json", REF);

    // A convenience for a cosmetic transport step must never be able to break
    // reading a room.
    expect(() => store.getBackendState(REF)).not.toThrow();
    expect(store.getBackendState(REF)).toBeNull();
  });

  it("survives archiving, which is the whole point of it", () => {
    store.setBackendState(REF, { previousParentId: "cat-1" });
    store.archiveRoom(REF);

    expect(store.getBackendState(REF)).toEqual({ previousParentId: "cat-1" });
  });
});
