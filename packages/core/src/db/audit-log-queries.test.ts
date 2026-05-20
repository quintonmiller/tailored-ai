import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { describe, it, expect, beforeEach } from "vitest";
import { AuditLog, AuditEntry, AuditVerifyResult } from "./audit-log-queries";

function makeTempDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp   TEXT NOT NULL,
      actor       TEXT NOT NULL,
      action      TEXT NOT NULL,
      before      TEXT,
      after       TEXT,
      context     TEXT,
      hash        TEXT NOT NULL,
      prev_hash   TEXT NOT NULL
    );
  `);
  return db;
}

describe("AuditLog", () => {
  let db: Database.Database;
  let audit: AuditLog;

  beforeEach(() => {
    db = makeTempDb();
    audit = new AuditLog(db);
  });

  it("writes an entry and returns it", () => {
    const entry = audit.write({
      actor: "test",
      action: "config_update",
      before: { setting: "old" },
      after: { setting: "new" },
    });

    expect(entry.id).toBe(1);
    expect(entry.actor).toBe("test");
    expect(entry.action).toBe("config_update");
    expect(entry.before).toBe('{"setting":"old"}');
    expect(entry.after).toBe('{"setting":"new"}');
    expect(entry.hash).toBeDefined();
    expect(entry.prev_hash).toBe("genesis");
  });

  it("chains hashes correctly", () => {
    const first = audit.write({
      actor: "test",
      action: "config_update",
      before: { a: 1 },
      after: { a: 2 },
    });

    const second = audit.write({
      actor: "test",
      action: "permission_grant",
      before: { role: "viewer" },
      after: { role: "editor" },
    });

    expect(second.prev_hash).toBe(first.hash);
  });

  it("verifies a valid chain", () => {
    audit.write({ actor: "test", action: "config_update", before: { a: 1 }, after: { a: 2 } });
    audit.write({ actor: "test", action: "permission_grant", before: { r: "v" }, after: { r: "e" } });

    const result = audit.verify();
    expect(result.valid).toBe(true);
    expect(result.inspected).toBe(2);
    expect(result.brokenAt).toBeNull();
  });

  it("detects tampered before field", () => {
    audit.write({ actor: "test", action: "config_update", before: { a: 1 }, after: { a: 2 } });

    // Tamper with the before field directly in the DB
    db.prepare("UPDATE audit_log SET before = '{\"tampered\": true}' WHERE id = 1").run();

    const result = audit.verify();
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(1);
  });

  it("detects tampered prev_hash", () => {
    audit.write({ actor: "test", action: "config_update", before: { a: 1 }, after: { a: 2 } });
    audit.write({ actor: "test", action: "permission_grant", before: { r: "v" }, after: { r: "e" } });

    // Tamper with the second row's prev_hash
    db.prepare("UPDATE audit_log SET prev_hash = 'bad_hash' WHERE id = 2").run();

    const result = audit.verify();
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(2);
  });

  it("lists entries in descending order", () => {
    audit.write({ actor: "test", action: "first" });
    audit.write({ actor: "test", action: "second" });
    audit.write({ actor: "test", action: "third" });

    const entries = audit.list();
    expect(entries).toHaveLength(3);
    expect(entries[0].action).toBe("third");
    expect(entries[1].action).toBe("second");
    expect(entries[2].action).toBe("first");
  });

  it("filters by action", () => {
    audit.write({ actor: "test", action: "config_update" });
    audit.write({ actor: "test", action: "permission_grant" });
    audit.write({ actor: "test", action: "config_update" });

    const entries = audit.list({ action: "config_update" });
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.action).toBe("config_update");
    }
  });

  it("limits results", () => {
    audit.write({ actor: "test", action: "first" });
    audit.write({ actor: "test", action: "second" });
    audit.write({ actor: "test", action: "third" });

    const entries = audit.list({ limit: 2 });
    expect(entries).toHaveLength(2);
    expect(entries[0].action).toBe("third");
    expect(entries[1].action).toBe("second");
  });

  it("handles null before/after/context", () => {
    const entry = audit.write({
      actor: "test",
      action: "simple_action",
    });

    expect(entry.before).toBeNull();
    expect(entry.after).toBeNull();
    expect(entry.context).toBeNull();
  });

  it("verifies empty log", () => {
    const result = audit.verify();
    expect(result.valid).toBe(true);
    expect(result.inspected).toBe(0);
  });
});
