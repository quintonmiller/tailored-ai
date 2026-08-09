import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * Dedup ledger for mail-polling agents. Set membership ("have I
 * seen this email before?") is a code problem, not an LLM problem
 * (see docs/agent-unification.md RC4).
 */
export type EmailDisposition = "noted" | "ignored" | "triaged" | "replied" | "archived";

export interface EmailSeenRow {
  message_id: string;
  thread_id: string | null;
  from_addr: string | null;
  subject_hash: string | null;
  seen_at: string;
  disposition: EmailDisposition;
  notes: string | null;
}

export interface MarkEmailSeenInput {
  message_id: string;
  thread_id?: string | null;
  from_addr?: string | null;
  /** Raw subject — will be hashed. Pass nothing to leave it null. */
  subject?: string | null;
  disposition?: EmailDisposition;
  notes?: string | null;
}

/**
 * Insert-or-update an email_seen row. Idempotent on message_id —
 * re-marking the same id updates disposition/notes/seen_at.
 */
export function markEmailSeen(db: Database.Database, input: MarkEmailSeenInput): EmailSeenRow {
  const subjectHash = input.subject
    ? createHash("sha1").update(input.subject.trim().toLowerCase()).digest("hex").slice(0, 16)
    : null;
  db.prepare(
    `INSERT INTO email_seen (message_id, thread_id, from_addr, subject_hash, disposition, notes)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET
       thread_id    = COALESCE(excluded.thread_id, email_seen.thread_id),
       from_addr    = COALESCE(excluded.from_addr, email_seen.from_addr),
       subject_hash = COALESCE(excluded.subject_hash, email_seen.subject_hash),
       disposition  = excluded.disposition,
       notes        = excluded.notes,
       seen_at      = datetime('now')`,
  ).run(
    input.message_id,
    input.thread_id ?? null,
    input.from_addr ?? null,
    subjectHash,
    input.disposition ?? "noted",
    input.notes ?? null,
  );
  return getEmailSeen(db, input.message_id)!;
}

export function getEmailSeen(db: Database.Database, messageId: string): EmailSeenRow | null {
  const row = db.prepare("SELECT * FROM email_seen WHERE message_id = ?").get(messageId) as EmailSeenRow | undefined;
  return row ?? null;
}

export function isEmailSeen(db: Database.Database, messageId: string): boolean {
  const row = db.prepare("SELECT 1 AS x FROM email_seen WHERE message_id = ?").get(messageId) as
    | { x: number }
    | undefined;
  return !!row;
}

/**
 * Batch helper: given a list of message ids (as fetched from Gmail),
 * return only the ones NOT in the ledger. Used by a mail poller to
 * filter at the start of every check.
 */
export function filterUnseenIds(db: Database.Database, messageIds: string[]): string[] {
  if (messageIds.length === 0) return [];
  const placeholders = messageIds.map(() => "?").join(",");
  const seen = db
    .prepare(`SELECT message_id FROM email_seen WHERE message_id IN (${placeholders})`)
    .all(...messageIds) as Array<{ message_id: string }>;
  const seenSet = new Set(seen.map((r) => r.message_id));
  return messageIds.filter((id) => !seenSet.has(id));
}

export function updateEmailDisposition(
  db: Database.Database,
  messageId: string,
  disposition: EmailDisposition,
  notes?: string | null,
): EmailSeenRow | null {
  const res = db
    .prepare(
      `UPDATE email_seen
       SET disposition = ?, notes = COALESCE(?, notes), seen_at = datetime('now')
       WHERE message_id = ?`,
    )
    .run(disposition, notes ?? null, messageId);
  if (res.changes === 0) return null;
  return getEmailSeen(db, messageId);
}

export interface EmailSeenQuery {
  from_addr?: string;
  disposition?: EmailDisposition | EmailDisposition[];
  since?: string;
  limit?: number;
}

export function listEmailSeen(db: Database.Database, q: EmailSeenQuery = {}): EmailSeenRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (q.from_addr) {
    clauses.push("from_addr = ?");
    params.push(q.from_addr);
  }
  if (q.disposition) {
    if (Array.isArray(q.disposition)) {
      const placeholders = q.disposition.map(() => "?").join(",");
      clauses.push(`disposition IN (${placeholders})`);
      params.push(...q.disposition);
    } else {
      clauses.push("disposition = ?");
      params.push(q.disposition);
    }
  }
  if (q.since) {
    clauses.push("seen_at >= ?");
    params.push(q.since);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = q.limit && q.limit > 0 ? `LIMIT ${Math.floor(q.limit)}` : "";
  return db
    .prepare(`SELECT * FROM email_seen ${where} ORDER BY seen_at DESC ${limit}`)
    .all(...params) as EmailSeenRow[];
}
