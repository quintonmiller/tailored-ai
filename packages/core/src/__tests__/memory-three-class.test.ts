import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMemoryBlockWithMeta } from "../agent/memory-inject.js";
import { createNote, sweepExpiredNotes } from "../db/note-queries.js";
import { initDatabase } from "../db/schema.js";
import { SqliteMemoryBackend } from "../memory/sqlite-backend.js";

let db: Database.Database;
let backend: SqliteMemoryBackend;

beforeEach(() => {
  db = initDatabase(":memory:");
  backend = new SqliteMemoryBackend(db);
});

afterEach(() => {
  db.close();
});

/**
 * End-to-end of the three-class observation convention (DUX10). Verifies
 * each tag family lands in the right injection lane and that ephemeral
 * notes auto-expire.
 */
describe("three-class observation retention (DUX10)", () => {
  it("pinned-preference always injects, profile injects on topical match only", async () => {
    createNote(db, {
      content: "never run destructive git without asking",
      project_id: "p",
      tags: ["preference", "pinned"],
      importance: 0.95,
    });
    createNote(db, {
      content: "user has a car",
      project_id: "p",
      tags: ["profile"],
      importance: 0.7,
    });

    // Unrelated message: pinned-preference appears, profile does NOT.
    const unrelated = await buildMemoryBlockWithMeta(backend, {
      userMessage: "explain how cron jobs work",
      projectId: "p",
    });
    expect(unrelated.block).toContain("never run destructive git");
    expect(unrelated.block).not.toContain("user has a car");

    // Topical message: profile fact surfaces in the relevance lane.
    const topical = await buildMemoryBlockWithMeta(backend, {
      userMessage: "i need to drive my car to the lake — any tips?",
      projectId: "p",
    });
    expect(topical.block).toContain("never run destructive git"); // pinned still there
    expect(topical.block).toContain("user has a car"); // profile surfaced
  });

  it("ephemeral note auto-expires past its ttl, profile survives the sweep", () => {
    // Profile fact — durable, no TTL.
    const profile = createNote(db, {
      content: "user works at acme",
      project_id: "p",
      tags: ["profile"],
      importance: 0.7,
      ttl_at: null,
    });
    // Ephemeral — already past its TTL.
    const stale = createNote(db, {
      content: "visiting the lake on saturday 2026-05-16",
      project_id: "p",
      tags: ["ephemeral"],
      importance: 0.4,
      ttl_at: new Date(Date.now() - 1000).toISOString(),
    });
    // Ephemeral — still in window.
    const fresh = createNote(db, {
      content: "doctor appointment thursday",
      project_id: "p",
      tags: ["ephemeral"],
      importance: 0.4,
      ttl_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    });

    const sweeps = sweepExpiredNotes(db);
    expect(sweeps).toBe(1); // only the stale one
    const survivors = db.prepare("SELECT id FROM notes ORDER BY id").all() as { id: string }[];
    const ids = survivors.map((r) => r.id);
    expect(ids).toContain(profile.id);
    expect(ids).toContain(fresh.id);
    expect(ids).not.toContain(stale.id);
  });

  it("high-importance profile facts survive the sweep even past TTL", () => {
    // Edge case: agent put a TTL on a profile fact by accident. Importance
    // 0.8+ saves it from sweep regardless.
    const accident = createNote(db, {
      content: "user works at acme",
      project_id: "p",
      tags: ["profile"],
      importance: 0.85,
      ttl_at: new Date(Date.now() - 1000).toISOString(),
    });
    sweepExpiredNotes(db);
    const row = db.prepare("SELECT id FROM notes WHERE id = ?").get(accident.id);
    expect(row).toBeTruthy();
  });
});
