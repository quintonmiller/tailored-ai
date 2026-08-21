/**
 * Resolving stored references to bytes for one request.
 *
 * History holds references so that base64 never reaches SQLite or
 * `capToolOutput`'s slice. Providers need actual bytes. Hydration is the seam
 * between those two facts, and the properties worth pinning are that it costs
 * nothing on the overwhelmingly common text-only request, that it reads each
 * blob once however many turns mention it, and that a blob it cannot read
 * becomes a text fallback rather than an exception.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mediaPart, textPart } from "../content/types.js";
import { initDatabase } from "../db/schema.js";
import { DiskMediaStore } from "../media/disk.js";
import { hydrateMedia } from "../media/hydrate.js";
import type { Message } from "../providers/interface.js";

function pngBytes(): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(10, 16);
  buf.writeUInt32BE(10, 20);
  return buf;
}

describe("hydrateMedia", () => {
  let db: Database.Database;
  let dir: string;
  let store: DiskMediaStore;

  beforeEach(() => {
    db = initDatabase(":memory:");
    dir = mkdtempSync(join(tmpdir(), "tai-hydrate-"));
    store = new DiskMediaStore({ db, dir });
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("does nothing without a store", async () => {
    expect(await hydrateMedia([{ role: "user", content: "hi" }], undefined)).toBeUndefined();
  });

  it("does nothing for a text-only conversation", async () => {
    // The common request must not pay for a feature it is not using.
    const messages: Message[] = [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ];
    expect(await hydrateMedia(messages, store)).toBeUndefined();
  });

  it("resolves a referenced blob to its exact bytes", async () => {
    const original = pngBytes();
    const ref = await store.put(original);
    const messages: Message[] = [{ role: "user", content: { parts: [mediaPart(ref)] } }];
    const map = await hydrateMedia(messages, store);
    expect(map?.get(ref.id)?.equals(original)).toBe(true);
  });

  it("reads a blob once however many turns reference it", async () => {
    const ref = await store.put(pngBytes());
    const messages: Message[] = [
      { role: "user", content: { parts: [mediaPart(ref)] } },
      { role: "assistant", content: "I see it" },
      { role: "user", content: { parts: [textPart("and again"), mediaPart(ref)] } },
    ];
    const map = await hydrateMedia(messages, store);
    expect(map?.size).toBe(1);
  });

  it("omits a reference whose blob is gone rather than throwing", async () => {
    // The converter then renders the placeholder — the model is told about an
    // image it cannot be shown, which beats both a crash and a silence.
    const ref = await store.put(pngBytes());
    await store.delete(ref.id);
    const messages: Message[] = [{ role: "user", content: { parts: [mediaPart(ref)] } }];
    expect(await hydrateMedia(messages, store)).toBeUndefined();
  });

  it("leaves a url-carrying reference to the provider", async () => {
    // Nothing to fetch locally: the provider can reach it itself.
    const messages: Message[] = [
      {
        role: "user",
        content: {
          parts: [mediaPart({ id: "z".repeat(64), mimeType: "image/png", bytes: 1, url: "https://x/y.png" })],
        },
      },
    ];
    expect(await hydrateMedia(messages, store)).toBeUndefined();
  });
});
