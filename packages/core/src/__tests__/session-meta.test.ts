import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newSession } from "../agent/session.js";
import { listSessions, updateSessionMeta } from "../db/queries.js";
import { initDatabase } from "../db/schema.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("session meta (title + pinned)", () => {
  it("defaults title to null and pinned to 0 on create", () => {
    const s = newSession(db, "m", "p", "k1");
    const row = listSessions(db).find((r) => r.id === s.id);
    expect(row?.title).toBeNull();
    expect(row?.pinned).toBe(0);
  });

  it("patches title only without touching pinned", () => {
    const s = newSession(db, "m", "p", "k1");
    const updated = updateSessionMeta(db, s.id, { title: "Migration plan" });
    expect(updated?.title).toBe("Migration plan");
    expect(updated?.pinned).toBe(0);
  });

  it("patches pinned only without touching title", () => {
    const s = newSession(db, "m", "p", "k1");
    updateSessionMeta(db, s.id, { title: "kept" });
    const updated = updateSessionMeta(db, s.id, { pinned: true });
    expect(updated?.pinned).toBe(1);
    expect(updated?.title).toBe("kept");
  });

  it("clears the title with null", () => {
    const s = newSession(db, "m", "p", "k1");
    updateSessionMeta(db, s.id, { title: "named" });
    const cleared = updateSessionMeta(db, s.id, { title: null });
    expect(cleared?.title).toBeNull();
  });

  it("returns undefined for missing sessions", () => {
    expect(updateSessionMeta(db, "nope", { pinned: true })).toBeUndefined();
  });

  it("listSessions sorts pinned first, then by updated_at desc", () => {
    const a = newSession(db, "m", "p", "ka");
    const b = newSession(db, "m", "p", "kb");
    const c = newSession(db, "m", "p", "kc");
    updateSessionMeta(db, a.id, { pinned: true });
    // Touch b so it's the most recently updated unpinned session.
    db.prepare("UPDATE sessions SET updated_at = datetime('now', '+1 second') WHERE id = ?").run(b.id);

    const ordered = listSessions(db);
    expect(ordered[0]?.id).toBe(a.id);
    expect(ordered.findIndex((r) => r.id === b.id)).toBeLessThan(ordered.findIndex((r) => r.id === c.id));
  });
});
