import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { AuditLog } from "../db/audit-log";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp  TEXT NOT NULL DEFAULT (datetime('now')),
      actor      TEXT NOT NULL,
      action     TEXT NOT NULL,
      before     TEXT,
      after      TEXT,
      context    TEXT,
      hash       TEXT NOT NULL,
      prev_hash  TEXT NOT NULL
    );

    CREATE TRIGGER audit_log_no_update
      BEFORE UPDATE ON audit_log
      BEGIN
        SELECT RAISE(ABORT, 'audit_log is append-only: UPDATE not allowed');
      END;

    CREATE TRIGGER audit_log_no_delete
      BEFORE DELETE ON audit_log
      BEGIN
        SELECT RAISE(ABORT, 'audit_log is append-only: DELETE not allowed');
      END;
  `);
  return db;
}

describe("AuditLog", () => {
  let db: Database.Database;
  let log: AuditLog;

  beforeEach(() => {
    db = createTestDb();
    log = new AuditLog(db);
  });

  describe("write()", () => {
    it("writes an entry and returns it", () => {
      const entry = log.write({
        actor: "test-agent",
        action: "config.write",
        before: { key: "old" },
        after: { key: "new" },
        context: { reason: "test" },
      });

      expect(entry.actor).toBe("test-agent");
      expect(entry.action).toBe("config.write");
      expect(entry.before).toBe('{"key":"old"}');
      expect(entry.after).toBe('{"key":"new"}');
      expect(entry.context).toBe('{"reason":"test"}');
      expect(entry.hash).toHaveLength(64);
      expect(entry.prev_hash).toBe("0".repeat(64));
      expect(entry.id).toBe(1);
    });

    it("chains prev_hash from previous entry", () => {
      const first = log.write({ actor: "agent", action: "config.write" });
      const second = log.write({ actor: "agent", action: "permission.change" });

      expect(second.prev_hash).toBe(first.hash);
      expect(second.prev_hash).not.toBe(first.prev_hash);
    });

    it("handles null before/after/context", () => {
      const entry = log.write({ actor: "user", action: "login" });
      expect(entry.before).toBeNull();
      expect(entry.after).toBeNull();
      expect(entry.context).toBeNull();
    });
  });

  describe("verify()", () => {
    // verify() exists precisely for the case where the trigger has been
    // bypassed (DB file copied + edited offline, raw sqlite3, etc.). The
    // happy-path triggers are tested below in "append-only enforcement".
    // Here we temporarily drop the triggers to simulate that bypass.
    function bypassTriggers() {
      db.exec("DROP TRIGGER IF EXISTS audit_log_no_update;");
      db.exec("DROP TRIGGER IF EXISTS audit_log_no_delete;");
    }

    it("returns valid for empty log", () => {
      const result = log.verify();
      expect(result.valid).toBe(true);
      expect(result.brokenAt).toBeUndefined();
    });

    it("returns valid for unmodified chain", () => {
      log.write({ actor: "agent", action: "config.write" });
      log.write({ actor: "agent", action: "permission.change" });
      log.write({ actor: "user", action: "config.read" });

      const result = log.verify();
      expect(result.valid).toBe(true);
    });

    it("detects tampered hash", () => {
      log.write({ actor: "agent", action: "config.write" });
      log.write({ actor: "agent", action: "permission.change" });

      // Tamper with the hash of the first entry
      bypassTriggers();
      db.prepare("UPDATE audit_log SET hash = 'tampered' WHERE id = 1").run();

      const result = log.verify();
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe(1);
    });

    it("detects tampered prev_hash", () => {
      log.write({ actor: "agent", action: "config.write" });
      log.write({ actor: "agent", action: "permission.change" });

      // Tamper with prev_hash of second entry
      bypassTriggers();
      db.prepare("UPDATE audit_log SET prev_hash = 'wrong' WHERE id = 2").run();

      const result = log.verify();
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe(2);
    });

    it("detects tampered content affecting hash", () => {
      log.write({ actor: "agent", action: "config.write" });
      log.write({ actor: "agent", action: "permission.change" });

      // Tamper with action of first entry (hash won't match)
      bypassTriggers();
      db.prepare("UPDATE audit_log SET action = 'hacked' WHERE id = 1").run();

      const result = log.verify();
      expect(result.valid).toBe(false);
      expect(result.brokenAt).toBe(1);
    });
  });

  describe("append-only enforcement", () => {
    it("rejects UPDATE via trigger", () => {
      log.write({ actor: "agent", action: "config.write" });

      expect(() => {
        db.prepare("UPDATE audit_log SET action = 'hacked' WHERE id = 1").run();
      }).toThrow("append-only");
    });

    it("rejects DELETE via trigger", () => {
      log.write({ actor: "agent", action: "config.write" });

      expect(() => {
        db.prepare("DELETE FROM audit_log WHERE id = 1").run();
      }).toThrow("append-only");
    });
  });

  describe("list()", () => {
    it("returns all entries", () => {
      log.write({ actor: "agent", action: "config.write" });
      log.write({ actor: "user", action: "login" });

      const entries = log.list();
      expect(entries).toHaveLength(2);
    });

    it("filters by actor", () => {
      log.write({ actor: "agent", action: "config.write" });
      log.write({ actor: "user", action: "login" });

      const entries = log.list({ actor: "agent" });
      expect(entries).toHaveLength(1);
      expect(entries[0].actor).toBe("agent");
    });

    it("filters by action", () => {
      log.write({ actor: "agent", action: "config.write" });
      log.write({ actor: "agent", action: "permission.change" });

      const entries = log.list({ action: "config.write" });
      expect(entries).toHaveLength(1);
    });

    it("respects limit", () => {
      log.write({ actor: "agent", action: "config.write" });
      log.write({ actor: "agent", action: "permission.change" });
      log.write({ actor: "user", action: "login" });

      const entries = log.list({ limit: 2 });
      expect(entries).toHaveLength(2);
    });
  });
});
