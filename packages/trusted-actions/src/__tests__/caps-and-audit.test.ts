import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyAuditChain, writeAudit } from "../audit/log.js";
import { checkCaps, readCapsFromEnv } from "../caps/enforcer.js";
import { migrate } from "../db/migrations.js";

describe("spending caps", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
    delete process.env.TA_CAP_PER_REQUEST;
    delete process.env.TA_CAP_PER_DAY;
    delete process.env.TA_CAP_PER_MONTH;
  });

  it("unlimited (env unset) → ok at any price", () => {
    const result = checkCaps(db, 999999, readCapsFromEnv());
    expect(result.ok).toBe(true);
  });

  it("per-request cap blocks over-cap purchase", () => {
    process.env.TA_CAP_PER_REQUEST = "50";
    const result = checkCaps(db, 100, readCapsFromEnv());
    expect(result.ok).toBe(false);
    expect(result.exceededCap).toBe("per_request");
  });

  it("per-request cap allows under-cap purchase", () => {
    process.env.TA_CAP_PER_REQUEST = "50";
    expect(checkCaps(db, 49.99, readCapsFromEnv()).ok).toBe(true);
    expect(checkCaps(db, 50, readCapsFromEnv()).ok).toBe(true);
  });

  it("'unlimited' string parses as null", () => {
    process.env.TA_CAP_PER_REQUEST = "unlimited";
    expect(checkCaps(db, 999, readCapsFromEnv()).ok).toBe(true);
  });

  it("per-day cap sums completed actions within 24h", () => {
    process.env.TA_CAP_PER_DAY = "100";
    const recent = new Date(Date.now() - 60_000).toISOString();
    // Insert two completed actions totalling $80
    db.prepare(
      `INSERT INTO actions (id, type, input_json, status, requested_by, requested_at, completed_at, result_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("a1", "x", "{}", "completed", "tester", recent, recent, JSON.stringify({ final_price: 50 }));
    db.prepare(
      `INSERT INTO actions (id, type, input_json, status, requested_by, requested_at, completed_at, result_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("a2", "x", "{}", "completed", "tester", recent, recent, JSON.stringify({ final_price: 30 }));

    expect(checkCaps(db, 15, readCapsFromEnv()).ok).toBe(true);
    const blocked = checkCaps(db, 25, readCapsFromEnv());
    expect(blocked.ok).toBe(false);
    expect(blocked.exceededCap).toBe("per_day");
  });

  it("pending/failed actions don't count toward the daily total", () => {
    process.env.TA_CAP_PER_DAY = "100";
    const recent = new Date().toISOString();
    db.prepare(
      `INSERT INTO actions (id, type, input_json, status, requested_by, requested_at, result_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("p1", "x", "{}", "pending_approval", "tester", recent, JSON.stringify({ max_price: 90 }));
    db.prepare(
      `INSERT INTO actions (id, type, input_json, status, requested_by, requested_at, completed_at, result_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("f1", "x", "{}", "failed", "tester", recent, recent, JSON.stringify({ final_price: 90 }));

    // Neither row should contribute → 80 is still OK
    expect(checkCaps(db, 80, readCapsFromEnv()).ok).toBe(true);
  });

  it("uses max_price as fallback when result_json is missing", () => {
    process.env.TA_CAP_PER_DAY = "100";
    const recent = new Date().toISOString();
    db.prepare(
      `INSERT INTO actions (id, type, input_json, status, requested_by, requested_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("a", "x", JSON.stringify({ max_price: 60 }), "completed", "tester", recent, recent);

    expect(checkCaps(db, 30, readCapsFromEnv()).ok).toBe(true);
    expect(checkCaps(db, 50, readCapsFromEnv()).ok).toBe(false);
  });

  afterEach(() => db.close());
});

describe("audit log (hash chain)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
  });

  afterEach(() => db.close());

  it("writes entries with hash chain", () => {
    writeAudit(db, { actor: "tai", action: "enqueue", after: "a" });
    writeAudit(db, { actor: "user", action: "approve", context: "b" });
    writeAudit(db, { actor: "executor", action: "execute_end", after: "c" });

    const rows = db.prepare("SELECT id, hash, prev_hash FROM audit_log ORDER BY id ASC").all() as Array<{
      id: number;
      hash: string;
      prev_hash: string;
    }>;
    expect(rows).toHaveLength(3);
    expect(rows[0].prev_hash).toBe("0".repeat(64));
    expect(rows[1].prev_hash).toBe(rows[0].hash);
    expect(rows[2].prev_hash).toBe(rows[1].hash);
  });

  it("verifyAuditChain returns ok for an intact chain", () => {
    writeAudit(db, { actor: "tai", action: "x" });
    writeAudit(db, { actor: "tai", action: "y" });
    expect(verifyAuditChain(db)).toEqual({ ok: true });
  });

  it("verifyAuditChain catches a tampered hash", () => {
    writeAudit(db, { actor: "tai", action: "x" });
    writeAudit(db, { actor: "tai", action: "y" });
    db.prepare("UPDATE audit_log SET hash = 'tampered' WHERE id = 1").run();
    const result = verifyAuditChain(db);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.brokenAt).toBe(1);
  });

  it("verifyAuditChain catches a tampered context", () => {
    writeAudit(db, { actor: "tai", action: "x", context: "original" });
    writeAudit(db, { actor: "tai", action: "y" });
    db.prepare("UPDATE audit_log SET context = 'forged' WHERE id = 1").run();
    const result = verifyAuditChain(db);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.brokenAt).toBe(1);
  });
});
