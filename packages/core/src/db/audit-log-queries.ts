import { createHash } from "node:crypto";
import Database from "better-sqlite3";

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
  before?: object | null;
  after?: object | null;
  context?: object | null;
}

export interface AuditVerifyResult {
  valid: boolean;
  inspected: number;
  brokenAt: number | null;
}

export class AuditLog {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  write(input: AuditWriteInput): AuditEntry {
    const { actor, action, before, after, context } = input;
    const timestamp = new Date().toISOString();

    // Get the previous hash (last row's hash, or "genesis" if empty)
    const prevRow = this.db
      .prepare("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1")
      .get() as { hash: string } | undefined;
    const prevHash = prevRow?.hash ?? "genesis";

    // Compute hash: SHA-256 of (timestamp + actor + action + before + after + context + prevHash)
    const beforeStr = before !== undefined && before !== null ? JSON.stringify(before) : "";
    const afterStr = after !== undefined && after !== null ? JSON.stringify(after) : "";
    const contextStr = context !== undefined && context !== null ? JSON.stringify(context) : "";

    const hashInput = `${timestamp}|${actor}|${action}|${beforeStr}|${afterStr}|${contextStr}|${prevHash}`;
    const hash = createHash("sha256").update(hashInput).digest("hex");

    const stmt = this.db.prepare(`
      INSERT INTO audit_log (timestamp, actor, action, before, after, context, hash, prev_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      timestamp,
      actor,
      action,
      before !== undefined && before !== null ? JSON.stringify(before) : null,
      after !== undefined && after !== null ? JSON.stringify(after) : null,
      context !== undefined && context !== null ? JSON.stringify(context) : null,
      hash,
      prevHash
    );

    return {
      id: result.lastInsertRowid as number,
      timestamp,
      actor,
      action,
      before: before !== undefined && before !== null ? JSON.stringify(before) : null,
      after: after !== undefined && after !== null ? JSON.stringify(after) : null,
      context: context !== undefined && context !== null ? JSON.stringify(context) : null,
      hash,
      prev_hash: prevHash,
    };
  }

  verify(): AuditVerifyResult {
    const rows = this.db
      .prepare("SELECT id, hash, prev_hash FROM audit_log ORDER BY id ASC")
      .all() as Array<{ id: number; hash: string; prev_hash: string }>;

    if (rows.length === 0) {
      return { valid: true, inspected: 0, brokenAt: null };
    }

    let expectedPrevHash = "genesis";

    for (const row of rows) {
      if (row.prev_hash !== expectedPrevHash) {
        return { valid: false, inspected: row.id - 1, brokenAt: row.id };
      }

      // Recompute hash to verify integrity
      const fullRow = this.db
        .prepare("SELECT timestamp, actor, action, before, after, context FROM audit_log WHERE id = ?")
        .get(row.id) as {
        timestamp: string;
        actor: string;
        action: string;
        before: string | null;
        after: string | null;
        context: string | null;
      };

      const beforeStr = fullRow.before ?? "";
      const afterStr = fullRow.after ?? "";
      const contextStr = fullRow.context ?? "";

      const hashInput = `${fullRow.timestamp}|${fullRow.actor}|${fullRow.action}|${beforeStr}|${afterStr}|${contextStr}|${expectedPrevHash}`;
      const computedHash = createHash("sha256").update(hashInput).digest("hex");

      if (row.hash !== computedHash) {
        return { valid: false, inspected: row.id - 1, brokenAt: row.id };
      }

      expectedPrevHash = row.hash;
    }

    return { valid: true, inspected: rows.length, brokenAt: null };
  }

  list(options?: { action?: string; limit?: number }): AuditEntry[] {
    const query = this.db.prepare(`
      SELECT id, timestamp, actor, action, before, after, context, hash, prev_hash
      FROM audit_log
      ${options?.action ? "WHERE action = ?" : ""}
      ORDER BY id DESC
      ${options?.limit ? "LIMIT ?" : ""}
    `);

    const params: unknown[] = [];
    if (options?.action) params.push(options.action);
    if (options?.limit) params.push(options.limit);

    return query.all(...params) as AuditEntry[];
  }
}
