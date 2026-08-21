/**
 * The media store reaching the runtime.
 *
 * This file exists because of a specific near-miss. P1 through P3 built the
 * content model, the store, the hydration step and the capability pre-flight —
 * and nothing constructed a store or handed one to the loop, so the entire
 * feature worked only in tests. That is the same failure mode as
 * `supportsTools`: a thing that exists, type-checks, and is never reached.
 *
 * So these assert the wiring itself rather than any behaviour of the parts.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db/schema.js";
import type { MediaStore } from "../media/interface.js";
import { listMediaStoreFactories, registerMediaStoreFactory, resolveMediaStore } from "../media/registry.js";

describe("media store registry", () => {
  let db: Database.Database;
  let dir: string;

  beforeEach(() => {
    db = initDatabase(":memory:");
    dir = mkdtempSync(join(tmpdir(), "tai-wiring-"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("ships disk as a registered factory, not as a hardcoded default", () => {
    // Built-ins are not privileged: the bundled store goes through the same
    // door a third-party S3 store would.
    expect(listMediaStoreFactories()).toContain("disk");
  });

  it("builds the disk store when nothing is configured", () => {
    const store = resolveMediaStore({ db, options: { dir } });
    expect(store?.id).toBe("disk");
  });

  it("passes config options through to the store", async () => {
    const store = resolveMediaStore({ db, options: { dir, maxBytes: 4 } });
    await expect(store?.put(Buffer.alloc(64))).rejects.toThrow(/over the 4-byte limit/);
  });

  it("returns undefined for an id nobody registered, rather than falling back", async () => {
    // Silently substituting disk for a missing S3 store would look like it was
    // working while writing blobs somewhere nobody is watching.
    expect(resolveMediaStore({ db, options: {} }, "s3-that-nobody-registered")).toBeUndefined();
  });

  it("lets a third party register and be selected", async () => {
    const fake: MediaStore = {
      id: "fake",
      put: async () => ({ id: "f".repeat(64), mimeType: "image/png", bytes: 0 }),
      get: async () => undefined,
      stat: async () => undefined,
      delete: async () => false,
    };
    registerMediaStoreFactory("fake-test-store", () => fake);
    expect(resolveMediaStore({ db, options: {} }, "fake-test-store")?.id).toBe("fake");
  });

  it("hands out URLs only when a base is configured", async () => {
    const bare = resolveMediaStore({ db, options: { dir } });
    const served = resolveMediaStore({ db, options: { dir, urlBase: "/api/media" } });
    const ref = await bare?.put(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]), { mimeType: "image/png" });
    expect(bare?.urlFor?.(ref?.id ?? "")).toBeUndefined();
    expect(served?.urlFor?.(ref?.id ?? "")).toBe(`/api/media/${ref?.id}`);
  });
});
