/**
 * Attachments through a room.
 *
 * Rooms carried text and nothing else: `RoomMessage.body` was a plain string
 * and the Discord rooms backend read `msg.content` without ever looking at
 * `msg.attachments`, so an image dropped in a room channel reached nobody and
 * said so to no one. These cover the three places that had to change — the
 * store round-trip, which attachments a wake actually carries, and the
 * transport's own capture — plus the case that has no text at all, because a
 * caption-less screenshot is the ordinary way to ask "what is this?".
 */

import type Database from "better-sqlite3";
import { ChannelType, type Client, Collection } from "discord.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordRoomBackend } from "../channels/discord-rooms.js";
import type { MediaRef } from "../content/types.js";
import { initDatabase } from "../db/schema.js";
import type { MediaStore } from "../media/interface.js";
import { LocalRoomBackend } from "../rooms/local.js";
import { RoomStore } from "../rooms/store.js";
import type { RoomMessage } from "../rooms/types.js";
import { MAX_WAKE_MEDIA, mediaForTurn } from "../rooms/watcher.js";

function ref(id: string, name = "shot.png"): MediaRef {
  return { id, mimeType: "image/png", bytes: 1024, name, width: 800, height: 600 };
}

function msg(over: Partial<RoomMessage> = {}): RoomMessage {
  return {
    id: "1",
    room: { backend: "local", id: "r" },
    cursor: "0001",
    raw: "hi",
    body: "hi",
    to: [],
    mentions: [],
    authorId: "a",
    authorLabel: "alex",
    fromSelf: false,
    createdAt: "2026-08-28T00:00:00Z",
    ...over,
  };
}

describe("mediaForTurn", () => {
  it("carries attachments from the messages a wake is about", () => {
    const picked = mediaForTurn([msg({ media: [ref("aaa")] }), msg({ id: "2" })]);
    expect(picked.map((m) => m.id)).toEqual(["aaa"]);
  });

  it("returns nothing for a backlog that carried none", () => {
    expect(mediaForTurn([msg(), msg({ id: "2" })])).toEqual([]);
    expect(mediaForTurn(undefined)).toEqual([]);
    expect(mediaForTurn([])).toEqual([]);
  });

  it("skips the agent's own posts, which are already in its session", () => {
    const picked = mediaForTurn([
      msg({ media: [ref("mine")], fromSelf: true }),
      msg({ id: "2", media: [ref("theirs")] }),
    ]);
    expect(picked.map((m) => m.id)).toEqual(["theirs"]);
  });

  it("sends one blob once, however many messages carried it", () => {
    // The id is a content address, so the same file posted twice is one blob —
    // paying for it twice would be a bug the ref shape exists to prevent.
    const picked = mediaForTurn([msg({ media: [ref("same")] }), msg({ id: "2", media: [ref("same")] })]);
    expect(picked.map((m) => m.id)).toEqual(["same"]);
  });

  it("caps a flood, keeping the most recent", () => {
    const many = Array.from({ length: MAX_WAKE_MEDIA + 3 }, (_, i) => msg({ id: String(i), media: [ref(`m${i}`)] }));
    const picked = mediaForTurn(many);
    expect(picked).toHaveLength(MAX_WAKE_MEDIA);
    // Newest kept, and still in conversation order rather than reversed.
    expect(picked.map((m) => m.id)).toEqual(["m3", "m4", "m5", "m6"]);
  });
});

describe("the local backend", () => {
  let db: Database.Database;
  let backend: LocalRoomBackend;
  let roomId: string;

  beforeEach(async () => {
    db = initDatabase(":memory:");
    backend = new LocalRoomBackend(db, new RoomStore(db));
    const room = await backend.createRoom({ name: "eng" });
    roomId = room.ref.id;
  });

  it("declares that it can carry media, and round-trips a ref", async () => {
    expect(backend.capabilities.media).toBe(true);
    await backend.post(roomId, { body: "look at this", speaker: "coder", media: [ref("blob1")] });

    const [got] = await backend.fetchSince(roomId, null, 10);
    expect(got.body).toBe("look at this");
    expect(got.media?.map((m) => m.id)).toEqual(["blob1"]);
    // The whole ref survives, not just the id — a surface lays out from these
    // without fetching bytes.
    expect(got.media?.[0]).toMatchObject({ mimeType: "image/png", width: 800, height: 600 });
  });

  it("leaves media absent, not empty, on a message that carried none", async () => {
    await backend.post(roomId, { body: "just talking", speaker: "coder" });
    const [got] = await backend.fetchSince(roomId, null, 10);
    expect(got.media).toBeUndefined();
    expect(db.prepare("SELECT media FROM room_messages").get()).toEqual({ media: null });
  });

  it("reads a backlog past one unreadable row rather than throwing", async () => {
    // One corrupt row must not make a whole room unreadable — the agent would
    // lose every message after it with no way to find out why.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await backend.post(roomId, { body: "first", speaker: "coder", media: [ref("ok")] });
    await backend.post(roomId, { body: "second", speaker: "coder" });
    db.prepare("UPDATE room_messages SET media = ? WHERE content LIKE '%first%'").run("{not json");

    const got = await backend.fetchSince(roomId, null, 10);
    expect(got.map((m) => m.body)).toEqual(["first", "second"]);
    expect(got[0].media).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("the Discord rooms backend", () => {
  const CHANNEL = "555";

  /** Minimal media store: enough to prove bytes went in and came back out. */
  function makeStore() {
    const blobs = new Map<string, Buffer>();
    return {
      blobs,
      put: vi.fn(async (bytes: Buffer, opts?: { mimeType?: string; name?: string }) => {
        // Content-addressed like the real one, so a repeat put is one blob.
        const id = `sha-${bytes.toString("hex").slice(0, 8)}`;
        blobs.set(id, bytes);
        return { id, mimeType: opts?.mimeType ?? "image/png", bytes: bytes.length, name: opts?.name };
      }),
      get: vi.fn(async (id: string) => (blobs.has(id) ? { bytes: blobs.get(id)! } : undefined)),
    };
  }

  function makeMessage(over: { id?: string; content?: string; attachments?: unknown[] } = {}) {
    const attachments = new Collection<string, unknown>();
    (over.attachments ?? []).forEach((a, i) => {
      attachments.set(String(i), a);
    });
    return {
      id: over.id ?? "100",
      content: over.content ?? "have a look",
      attachments,
      author: { id: "u1", username: "alex", bot: false },
      channel: { type: ChannelType.GuildText },
      channelId: CHANNEL,
      guildId: "g1",
      webhookId: null,
      createdTimestamp: 1_700_000_000_000,
    };
  }

  function makeBackend(messages: unknown[], store?: ReturnType<typeof makeStore>) {
    const collection = new Collection<string, unknown>();
    for (const m of messages) collection.set((m as { id: string }).id, m);
    const send = vi.fn(async (payload: unknown) => ({ ...makeMessage({ id: "sent" }), payload }));
    const channel = { id: CHANNEL, type: ChannelType.GuildText, messages: { fetch: async () => collection }, send };
    const client = { channels: { fetch: async () => channel }, user: { id: "bot" } };
    const backend = new DiscordRoomBackend(client as unknown as Client, {
      mediaStore: () => store as unknown as MediaStore,
    });
    return { backend, send };
  }

  it("declares media, and captures an attachment into the store on the way in", async () => {
    const store = makeStore();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer })),
    );
    const { backend } = makeBackend(
      [
        makeMessage({
          attachments: [{ id: "att-1", url: "https://cdn/x.png", contentType: "image/png", name: "x.png" }],
        }),
      ],
      store,
    );
    expect(backend.capabilities.media).toBe(true);

    const [got] = await backend.fetchSince(CHANNEL, null, 10);
    // Captured now, not referenced: a Discord URL expires before an agent that
    // wakes on a backlog would ever follow it.
    expect(store.put).toHaveBeenCalledTimes(1);
    expect(got.media).toHaveLength(1);
    expect(got.media?.[0].name).toBe("x.png");
    expect(got.body).toBe("have a look");
    vi.unstubAllGlobals();
  });

  it("pays nothing for a message that carried no attachment", async () => {
    const store = makeStore();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { backend } = makeBackend([makeMessage()], store);

    const [got] = await backend.fetchSince(CHANNEL, null, 10);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(got.media).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it("reads the room normally when no media store is configured", async () => {
    // The opt-out path: a deployment that never turned media on must behave
    // exactly as it did before, not fail on a message with a picture in it.
    const { backend } = makeBackend(
      [
        makeMessage({
          attachments: [{ id: "att-1", url: "https://cdn/x.png", contentType: "image/png", name: "x.png" }],
        }),
      ],
      undefined,
    );
    const [got] = await backend.fetchSince(CHANNEL, null, 10);
    expect(got.body).toBe("have a look");
    expect(got.media).toBeUndefined();
  });

  it("does not re-download an attachment it has already captured", async () => {
    // The cross-room view re-reads every other room from a null cursor each
    // time its slice cache expires, walking the same messages again — for a
    // view that renders text and never looks at the bytes.
    const store = makeStore();
    const fetchSpy = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }));
    vi.stubGlobal("fetch", fetchSpy);
    const { backend } = makeBackend(
      [
        makeMessage({
          attachments: [{ id: "att-1", url: "https://cdn/x.png", contentType: "image/png", name: "x.png" }],
        }),
      ],
      store,
    );

    const first = await backend.fetchSince(CHANNEL, null, 10);
    const second = await backend.fetchSince(CHANNEL, null, 10);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // And the second read still reports the attachment, from the memo.
    expect(second[0].media?.map((m) => m.id)).toEqual(first[0].media?.map((m) => m.id));
    vi.unstubAllGlobals();
  });

  it("attaches an outbound file to the LAST chunk of a split message", async () => {
    const store = makeStore();
    const ref = await store.put(Buffer.from([9, 9, 9]), { name: "chart.png" });
    const { backend, send } = makeBackend([], store);

    // Long enough to split, so "which chunk gets the file" is observable.
    await backend.post(CHANNEL, { body: "x".repeat(3000), speaker: "coder", media: [ref] });

    expect(send.mock.calls.length).toBeGreaterThan(1);
    const payloads = send.mock.calls.map(([p]) => p as { files?: unknown[] });
    // The picture must not appear above the text that introduces it.
    expect(payloads.slice(0, -1).every((p) => !p.files)).toBe(true);
    expect(payloads.at(-1)?.files).toHaveLength(1);
  });

  it("still posts an attachment-only message", async () => {
    const store = makeStore();
    const ref = await store.put(Buffer.from([7]), { name: "shot.png" });
    const { backend, send } = makeBackend([], store);

    const posted = await backend.post(CHANNEL, { body: "", speaker: "coder", media: [ref] });

    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0][0] as { files?: unknown[] }).files).toHaveLength(1);
    expect(posted).not.toBeNull();
  });
});
