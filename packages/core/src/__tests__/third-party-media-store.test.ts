/**
 * A media store written the way a plugin author would write one.
 *
 * `registerMediaStoreFactory` says an out-of-tree store is a supported thing,
 * and the interface doc names S3 specifically. But a store also has to keep its
 * metadata in the `media` table, because that table is what the retention sweep
 * walks, what `touchMedia` keeps alive, and what the byte total sums. A store
 * with its own table is invisible to all three: its blobs never expire and
 * never appear in a total.
 *
 * So this builds a store using *only* what core exports — no deep imports, no
 * hand-written SQL — and then drives the shared machinery over it. If a helper
 * a store needs stops being public, this fails to compile, which is the point.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db/schema.js";
import {
  deleteMediaRow,
  findExpiredMedia,
  getMediaRow,
  type MediaRef,
  type MediaStore,
  type PutMediaOptions,
  type StoredMedia,
  sniffMedia,
  totalMediaBytes,
  touchMedia,
  upsertMediaRow,
} from "../index.js";

const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000a49444154789c6360000002000100" +
    "05fe02fea7b7d4990000000049454e44ae426082",
  "hex",
);

/** Bytes live in a Map instead of a bucket; everything else is what S3 would do. */
class FakeRemoteStore implements MediaStore {
  readonly id = "fake-remote";
  readonly objects = new Map<string, Buffer>();

  constructor(private readonly db: Database.Database) {}

  private key(id: string): string {
    return `media/${id.slice(0, 2)}/${id}`;
  }

  async put(bytes: Buffer, opts: PutMediaOptions = {}): Promise<MediaRef> {
    const sniffed = sniffMedia(bytes, opts.mimeType);
    const id = require("node:crypto").createHash("sha256").update(bytes).digest("hex");
    const ref: MediaRef = {
      id,
      mimeType: sniffed.mimeType,
      bytes: bytes.byteLength,
      ...(opts.name ? { name: opts.name } : {}),
    };
    const key = this.key(id);
    if (!this.objects.has(key)) this.objects.set(key, bytes);
    // The remote key goes in `path`, which is what makes the row portable:
    // core never interprets it, the store always does.
    upsertMediaRow(this.db, { ref, path: key, sessionId: opts.sessionId ?? null });
    return ref;
  }

  async get(id: string): Promise<StoredMedia | undefined> {
    const row = getMediaRow(this.db, id);
    if (!row) return undefined;
    const bytes = this.objects.get(row.path);
    return bytes ? { ref: row.ref, bytes } : undefined;
  }

  async stat(id: string): Promise<MediaRef | undefined> {
    return getMediaRow(this.db, id)?.ref;
  }

  async delete(id: string): Promise<boolean> {
    const row = getMediaRow(this.db, id);
    if (!row) return false;
    this.objects.delete(row.path);
    deleteMediaRow(this.db, id);
    return true;
  }

  urlFor(id: string): string | undefined {
    return `https://example-bucket.test/${this.key(id)}`;
  }
}

describe("a store built only from core's public API", () => {
  let db: Database.Database;
  let store: FakeRemoteStore;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new FakeRemoteStore(db);
  });
  afterEach(() => db.close());

  it("round-trips bytes and metadata", async () => {
    const ref = await store.put(PNG, { name: "chart.png", sessionId: "s1" });
    expect(ref.mimeType).toBe("image/png");
    expect((await store.get(ref.id))?.bytes.equals(PNG)).toBe(true);
    expect((await store.stat(ref.id))?.name).toBe("chart.png");
  });

  it("is content-addressed, so the same bytes cost one object", async () => {
    const a = await store.put(PNG, { name: "one.png" });
    const b = await store.put(PNG, { name: "two.png" });
    expect(b.id).toBe(a.id);
    expect(store.objects.size).toBe(1);
  });

  it("shows up in the deployment's byte total", async () => {
    await store.put(PNG);
    expect(totalMediaBytes(db)).toBe(PNG.byteLength);
  });

  it("is reachable by the retention sweep, and delete clears both halves", async () => {
    const ref = await store.put(PNG, { sessionId: "s1" });
    // Age the row the way time would.
    db.prepare("UPDATE media SET last_seen_at = datetime('now', '-90 days') WHERE id = ?").run(ref.id);

    const expired = findExpiredMedia(db, 30);
    expect(expired.map((r) => r.ref.id)).toContain(ref.id);

    expect(await store.delete(ref.id)).toBe(true);
    expect(store.objects.size).toBe(0);
    expect(await store.stat(ref.id)).toBeUndefined();
    expect(totalMediaBytes(db)).toBe(0);
  });

  it("survives a touch, which is how a served rendition keeps its parent alive", async () => {
    const ref = await store.put(PNG);
    db.prepare("UPDATE media SET last_seen_at = datetime('now', '-90 days') WHERE id = ?").run(ref.id);
    expect(findExpiredMedia(db, 30)).toHaveLength(1);

    touchMedia(db, ref.id);
    expect(findExpiredMedia(db, 30)).toHaveLength(0);
  });

  it("reports absence rather than a half-answer when the blob is gone", async () => {
    const ref = await store.put(PNG);
    store.objects.clear(); // the bucket lost it; the row survives
    expect(await store.get(ref.id)).toBeUndefined();
    // stat still answers, because metadata is ours and bytes are not.
    expect(await store.stat(ref.id)).toBeDefined();
  });
});
