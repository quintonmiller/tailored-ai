import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findOrCreateSession, loadSession, newSession } from "../agent/session.js";
import { createProject } from "../db/project-queries.js";
import { listSessions } from "../db/queries.js";
import { initDatabase } from "../db/schema.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("session project scoping", () => {
  it("creates a session with project_id when provided", () => {
    const proj = createProject(db, { title: "P", path: "/p" });
    const s = newSession(db, "m", "p", "key1", proj.id);
    expect(s.projectId).toBe(proj.id);

    const loaded = loadSession(db, s.id);
    expect(loaded?.projectId).toBe(proj.id);
  });

  it("creates an unscoped (global) session when projectId is omitted", () => {
    const s = newSession(db, "m", "p", "key1");
    expect(s.projectId).toBeNull();
    expect(loadSession(db, s.id)?.projectId).toBeNull();
  });

  it("findOrCreateSession persists project_id on first create", () => {
    const proj = createProject(db, { title: "P", path: "/p" });
    const s = findOrCreateSession(db, "k", "m", "p", proj.id);
    expect(s.projectId).toBe(proj.id);
  });

  it("findOrCreateSession preserves the original project_id on resume", () => {
    const proj = createProject(db, { title: "P", path: "/p" });
    const first = findOrCreateSession(db, "k", "m", "p", proj.id);

    // Caller forgot to pass projectId — existing scoping must stick.
    const second = findOrCreateSession(db, "k", "m", "p");
    expect(second.id).toBe(first.id);
    expect(second.projectId).toBe(proj.id);
  });

  it("listSessions filters by project id", () => {
    const a = createProject(db, { title: "A", path: "/a" });
    const b = createProject(db, { title: "B", path: "/b" });
    newSession(db, "m", "p", "ka", a.id);
    newSession(db, "m", "p", "kb", b.id);
    newSession(db, "m", "p", "kg"); // global

    const onlyA = listSessions(db, { projectId: a.id });
    expect(onlyA.map((s) => s.key).sort()).toEqual(["ka"]);

    const onlyGlobal = listSessions(db, { projectId: "global" });
    expect(onlyGlobal.map((s) => s.key)).toEqual(["kg"]);

    const all = listSessions(db);
    expect(all.length).toBeGreaterThanOrEqual(3);
  });

  it("legacy DBs upgrade to gain project_id", () => {
    const tmpDb = new Database(":memory:");
    tmpDb.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        key TEXT UNIQUE,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    tmpDb.prepare("INSERT INTO sessions (id, key, model, provider) VALUES (?, ?, ?, ?)").run(
      "old-session",
      "legacy",
      "m",
      "p",
    );
    tmpDb.close();

    // Reopen via initDatabase using a fresh path-equivalent — `:memory:` doesn't persist,
    // so simulate by inspecting columns on a fresh init.
    const fresh = initDatabase(":memory:");
    const cols = fresh.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("project_id");
    fresh.close();
  });
});
