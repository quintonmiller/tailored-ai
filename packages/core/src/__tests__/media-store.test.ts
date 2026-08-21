/**
 * The media store: content addressing, type resolution, and retention.
 *
 * The properties worth defending here are the two the design leans on
 * elsewhere — that identical bytes produce one blob and one id (so the loop's
 * repeat detector keeps working and disk does not grow per capture), and that
 * a caller's claim about a payload never overrides what the bytes say.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db/schema.js";
import { DiskMediaStore } from "../media/disk.js";
import { MediaTooLargeError } from "../media/interface.js";
import { findExpiredMedia, listMediaRows, totalMediaBytes } from "../media/queries.js";
import { sniffMedia, UnknownMediaTypeError } from "../media/sniff.js";

/** Smallest valid-enough PNG header: signature + an IHDR carrying dimensions. */
function pngBytes(width = 3, height = 5): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

describe("sniffMedia", () => {
  it("identifies a PNG and reads its dimensions from the bytes", () => {
    expect(sniffMedia(pngBytes(640, 480))).toEqual({ mimeType: "image/png", width: 640, height: 480 });
  });

  it("identifies a PDF", () => {
    expect(sniffMedia(Buffer.from("%PDF-1.7\n")).mimeType).toBe("application/pdf");
  });

  it("ignores a wrong declared type when the bytes are recognizable", () => {
    // The case an attacker controls: a payload claiming to be something benign.
    expect(sniffMedia(pngBytes(), "text/plain").mimeType).toBe("image/png");
  });

  it("falls back to the declared type only when the bytes say nothing", () => {
    expect(sniffMedia(Buffer.from("just words"), "text/plain").mimeType).toBe("text/plain");
  });

  it("fails loudly rather than guessing when nothing identifies the payload", () => {
    expect(() => sniffMedia(Buffer.from("just words"))).toThrow(UnknownMediaTypeError);
  });
});

describe("DiskMediaStore", () => {
  let db: Database.Database;
  let dir: string;
  let store: DiskMediaStore;

  beforeEach(() => {
    db = initDatabase(":memory:");
    dir = mkdtempSync(join(tmpdir(), "tai-media-test-"));
    store = new DiskMediaStore({ db, dir });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores bytes and returns a content-addressed ref", async () => {
    const ref = await store.put(pngBytes(1024, 768), { name: "chart.png" });
    expect(ref.id).toMatch(/^[0-9a-f]{64}$/);
    expect(ref.mimeType).toBe("image/png");
    expect(ref.bytes).toBe(24);
    expect(ref.name).toBe("chart.png");
    expect(ref.width).toBe(1024);
    expect(ref.height).toBe(768);
  });

  it("gives identical bytes the same id and stores one blob", async () => {
    const a = await store.put(pngBytes());
    const b = await store.put(pngBytes());
    expect(a.id).toBe(b.id);
    expect(listMediaRows(db)).toHaveLength(1);
    // One blob, counted once — a screenshot re-taken every tick costs one file.
    expect(totalMediaBytes(db)).toBe(24);
  });

  it("round-trips the exact bytes", async () => {
    const original = pngBytes(7, 9);
    const ref = await store.put(original);
    const stored = await store.get(ref.id);
    expect(stored?.bytes.equals(original)).toBe(true);
    expect(stored?.ref.id).toBe(ref.id);
  });

  it("reports absence for an unknown id rather than throwing", async () => {
    expect(await store.get("0".repeat(64))).toBeUndefined();
    expect(await store.stat("0".repeat(64))).toBeUndefined();
    expect(await store.delete("0".repeat(64))).toBe(false);
  });

  it("stats without reading the payload", async () => {
    const ref = await store.put(pngBytes(2, 3));
    expect(await store.stat(ref.id)).toEqual(ref);
  });

  it("deletes both the blob and its row", async () => {
    const ref = await store.put(pngBytes());
    expect(await store.delete(ref.id)).toBe(true);
    expect(await store.get(ref.id)).toBeUndefined();
    expect(listMediaRows(db)).toHaveLength(0);
  });

  it("rejects an oversized payload before writing anything", async () => {
    const tiny = new DiskMediaStore({ db, dir, maxBytes: 8 });
    await expect(tiny.put(pngBytes())).rejects.toThrow(MediaTooLargeError);
    expect(listMediaRows(db)).toHaveLength(0);
  });

  it("hands out a URL only when the deployment configured one", async () => {
    const ref = await store.put(pngBytes());
    expect(store.urlFor(ref.id)).toBeUndefined();
    const served = new DiskMediaStore({ db, dir, urlBase: "/api/media/" });
    expect(served.urlFor(ref.id)).toBe(`/api/media/${ref.id}`);
  });

  it("keeps fresh blobs out of the retention sweep", async () => {
    await store.put(pngBytes());
    expect(findExpiredMedia(db, 30)).toHaveLength(0);
  });

  it("sweeps a blob whose last use is older than the retention window", async () => {
    const ref = await store.put(pngBytes());
    db.prepare("UPDATE media SET last_seen_at = datetime('now', '-90 days') WHERE id = ?").run(ref.id);
    const expired = findExpiredMedia(db, 30);
    expect(expired.map((r) => r.ref.id)).toEqual([ref.id]);
  });

  it("re-storing refreshes last use, so a blob in active use never expires", async () => {
    const ref = await store.put(pngBytes());
    db.prepare("UPDATE media SET last_seen_at = datetime('now', '-90 days') WHERE id = ?").run(ref.id);
    await store.put(pngBytes());
    expect(findExpiredMedia(db, 30)).toHaveLength(0);
  });
});
