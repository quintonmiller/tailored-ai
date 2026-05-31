import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

type Db = Database.Database;

export interface AuditEntry {
  actor: string;
  action: string;
  before?: string;
  after?: string;
  context?: string;
}

/**
 * Append a hash-chained audit entry. Mirrors the pattern from
 * packages/core/src/db/audit-log.ts (the core audit log from
 * ptask_58ed4eee) but lives in the executor's separate DB.
 *
 * Each entry's hash covers (prev_hash || timestamp || actor || action ||
 * before || after || context). The first entry chains from
 * 64 zero-bytes.
 */
export function writeAudit(db: Db, entry: AuditEntry): void {
  const lastRow = db.prepare("SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1").get() as
    | { hash: string }
    | undefined;
  const prevHash = lastRow?.hash ?? "0".repeat(64);

  const timestamp = new Date().toISOString();
  const payload = [
    prevHash,
    timestamp,
    entry.actor,
    entry.action,
    entry.before ?? "",
    entry.after ?? "",
    entry.context ?? "",
  ].join("\x1f");
  const hash = createHash("sha256").update(payload).digest("hex");

  db.prepare(
    `INSERT INTO audit_log (timestamp, actor, action, before, after, context, hash, prev_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    timestamp,
    entry.actor,
    entry.action,
    entry.before ?? null,
    entry.after ?? null,
    entry.context ?? null,
    hash,
    prevHash,
  );
}

/**
 * Walk the audit chain and return the first broken entry id, or null
 * if the chain is intact. O(N); call sparingly.
 */
export function verifyAuditChain(db: Db): { ok: true } | { ok: false; brokenAt: number } {
  const rows = db
    .prepare(
      `SELECT id, timestamp, actor, action, before, after, context, hash, prev_hash
       FROM audit_log ORDER BY id ASC`,
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

  let expectedPrev = "0".repeat(64);
  for (const row of rows) {
    if (row.prev_hash !== expectedPrev) return { ok: false, brokenAt: row.id };
    const payload = [
      row.prev_hash,
      row.timestamp,
      row.actor,
      row.action,
      row.before ?? "",
      row.after ?? "",
      row.context ?? "",
    ].join("\x1f");
    const recomputed = createHash("sha256").update(payload).digest("hex");
    if (recomputed !== row.hash) return { ok: false, brokenAt: row.id };
    expectedPrev = row.hash;
  }
  return { ok: true };
}
