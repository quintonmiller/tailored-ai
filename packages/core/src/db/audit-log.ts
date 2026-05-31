import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export interface AuditEntry {
  id: number;
  timestamp: string;
  actor: string;
  action: string;
  before: string | null;
  after: string | null;
  context: string | null;
  hash: string;
  prev_hash: string;
}

export interface AuditWriteInput {
  actor: string;
  action: string;
  before?: unknown;
  after?: unknown;
  context?: unknown;
}

export interface AuditVerifyResult {
  valid: boolean;
  brokenAt?: number;
}

const GENESIS_HASH = "0".repeat(64);

function computeHash(
  timestamp: string,
  actor: string,
  action: string,
  before: string | null,
  after: string | null,
  context: string | null,
  prevHash: string,
): string {
  const data = `${timestamp}|${actor}|${action}|${before}|${after}|${context}|${prevHash}`;
  return createHash("sha256").update(data).digest("hex");
}

function getLastHash(db: Database.Database): string {
  const row = db.prepare("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1").get() as { hash: string } | undefined;
  return row?.hash ?? GENESIS_HASH;
}

export class AuditLog {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  write(input: AuditWriteInput): AuditEntry {
    const timestamp = new Date().toISOString();
    const before = input.before != null ? JSON.stringify(input.before) : null;
    const after = input.after != null ? JSON.stringify(input.after) : null;
    const context = input.context != null ? JSON.stringify(input.context) : null;
    const prevHash = getLastHash(this.db);
    const hash = computeHash(timestamp, input.actor, input.action, before, after, context, prevHash);

    const stmt = this.db.prepare(`
      INSERT INTO audit_log (timestamp, actor, action, before, after, context, hash, prev_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(timestamp, input.actor, input.action, before, after, context, hash, prevHash);

    return {
      id: result.lastInsertRowid as unknown as number,
      timestamp,
      actor: input.actor,
      action: input.action,
      before,
      after,
      context,
      hash,
      prev_hash: prevHash,
    };
  }

  verify(): AuditVerifyResult {
    const rows = this.db
      .prepare(
        "SELECT id, timestamp, actor, action, before, after, context, hash, prev_hash FROM audit_log ORDER BY id",
      )
      .all() as Array<{
      id: number;
      timestamp: string;
      actor: string;
      action: string;
      before: string | null;
      after: string | null;
      context: string | null;
      hash: string;
      prev_hash: string;
    }>;

    if (rows.length === 0) return { valid: true };

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const expectedPrev = i === 0 ? GENESIS_HASH : rows[i - 1].hash;

      if (row.prev_hash !== expectedPrev) {
        return { valid: false, brokenAt: row.id };
      }

      const expectedHash = computeHash(
        row.timestamp,
        row.actor,
        row.action,
        row.before,
        row.after,
        row.context,
        row.prev_hash,
      );
      if (row.hash !== expectedHash) {
        return { valid: false, brokenAt: row.id };
      }
    }

    return { valid: true };
  }

  list(options?: { actor?: string; action?: string; limit?: number }): AuditEntry[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options?.actor) {
      conditions.push("actor = ?");
      params.push(options.actor);
    }
    if (options?.action) {
      conditions.push("action = ?");
      params.push(options.action);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = options?.limit != null ? "LIMIT ?" : "";
    if (options?.limit != null) params.push(options.limit);

    const rows = this.db
      .prepare(
        `SELECT id, timestamp, actor, action, before, after, context, hash, prev_hash FROM audit_log ${where} ORDER BY id DESC ${limit}`,
      )
      .all(...params) as Array<{
      id: number;
      timestamp: string;
      actor: string;
      action: string;
      before: string | null;
      after: string | null;
      context: string | null;
      hash: string;
      prev_hash: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      actor: row.actor,
      action: row.action,
      before: row.before,
      after: row.after,
      context: row.context,
      hash: row.hash,
      prev_hash: row.prev_hash,
    }));
  }
}
