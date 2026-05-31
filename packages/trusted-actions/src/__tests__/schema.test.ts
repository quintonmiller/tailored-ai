import * as crypto from "node:crypto";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../db/schema";

describe("Schema", () => {
  let db: Database;

  beforeEach(() => {
    closeDb();
    db = getDb(":memory:");
  });

  afterEach(() => {
    closeDb();
  });

  it("creates all three tables", () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("actions");
    expect(names).toContain("approvals");
    expect(names).toContain("audit_log");
  });

  it("allows inserting and reading an action", () => {
    const insert = db.prepare(
      `INSERT INTO actions (id, type, input_json, status, requested_by, requested_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run("a1", "test", "{}", "pending", "agent", new Date().toISOString());

    const row = db.prepare("SELECT * FROM actions WHERE id = ?").get("a1");
    expect(row).toBeDefined();
    expect(row.type).toBe("test");
    expect(row.status).toBe("pending");
  });

  it("audit_log entries chain correctly", () => {
    const insert = db.prepare(`INSERT INTO audit_log (actor, action, hash, prev_hash) VALUES (?, ?, ?, ?)`);

    const entries: Array<{ hash: string; prev_hash: string }> = [];
    let prevHash = "genesis";

    for (let i = 0; i < 3; i++) {
      const hash = crypto.createHash("sha256").update(`${i}-${prevHash}`).digest("hex");
      insert.run(`actor-${i}`, `action-${i}`, hash, prevHash);
      entries.push({ hash, prev_hash: prevHash });
      prevHash = hash;
    }

    const rows = db.prepare("SELECT * FROM audit_log ORDER BY id").all() as Array<{
      id: number;
      hash: string;
      prev_hash: string;
    }>;

    expect(rows.length).toBe(3);

    // First entry has genesis as prev_hash
    expect(rows[0].prev_hash).toBe("genesis");

    // Each subsequent entry's prev_hash matches the previous entry's hash
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].prev_hash).toBe(rows[i - 1].hash);
    }
  });
});
