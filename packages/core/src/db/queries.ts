import type Database from "better-sqlite3";
import { decodeMessageContent, encodeMessageContent } from "../content/codec.js";
import type { Message } from "../providers/interface.js";

export interface SessionRow {
  id: string;
  key: string | null;
  model: string;
  provider: string;
  project_id: string | null;
  title: string | null;
  pinned: number;
  created_at: string;
  updated_at: string;
}

export interface SessionMetaPatch {
  title?: string | null;
  pinned?: boolean;
}

export interface ListSessionsOptions {
  /** Filter to a specific project. Use the literal string "global" to fetch only un-scoped sessions. */
  projectId?: string | "global";
  limit?: number;
}

interface MessageRow {
  id: number;
  session_id: string;
  role: string;
  content: string | null;
  tool_calls: string | null;
  tool_call_id: string | null;
  reasoning: string | null;
  created_at: string;
}

export function createSession(
  db: Database.Database,
  id: string,
  model: string,
  provider: string,
  key?: string,
  projectId?: string | null,
): void {
  db.prepare("INSERT INTO sessions (id, key, model, provider, project_id) VALUES (?, ?, ?, ?, ?)").run(
    id,
    key ?? null,
    model,
    provider,
    projectId ?? null,
  );
}

export function getSession(db: Database.Database, id: string): SessionRow | undefined {
  return db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
}

export function getSessionByKey(db: Database.Database, key: string): SessionRow | undefined {
  return db.prepare("SELECT * FROM sessions WHERE key = ?").get(key) as SessionRow | undefined;
}

export function saveMessage(db: Database.Database, sessionId: string, msg: Message, opts?: SaveMessageOptions): void {
  db.prepare(
    "INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, reasoning, compaction_summary_for) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    sessionId,
    msg.role,
    encodeMessageContent(msg.content),
    msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
    msg.toolCallId ?? null,
    msg.reasoning ?? null,
    opts?.compactionSummaryFor ?? null,
  );
}

export interface SaveMessageOptions {
  /**
   * Marks this row as the summary standing in for a compaction, so undoing that
   * compaction can remove it again. Set by `compactSession` and nothing else.
   */
  compactionSummaryFor?: number;
}

export function updateSessionModelProvider(db: Database.Database, id: string, model: string, provider: string): void {
  db.prepare("UPDATE sessions SET model = ?, provider = ? WHERE id = ?").run(model, provider, id);
}

/**
 * Patch session metadata (title, pinned). Only fields present in `patch` are
 * touched. Returns the updated row, or undefined if the session doesn't exist.
 */
export function updateSessionMeta(db: Database.Database, id: string, patch: SessionMetaPatch): SessionRow | undefined {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.title !== undefined) {
    sets.push("title = ?");
    params.push(patch.title);
  }
  if (patch.pinned !== undefined) {
    sets.push("pinned = ?");
    params.push(patch.pinned ? 1 : 0);
  }
  if (sets.length > 0) {
    params.push(id);
    db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }
  return getSession(db, id);
}

export function clearSessionKey(db: Database.Database, key: string): void {
  db.prepare("UPDATE sessions SET key = NULL WHERE key = ?").run(key);
}

export function listSessions(db: Database.Database, opts?: ListSessionsOptions): SessionRow[] {
  const params: unknown[] = [];
  let where = "";
  if (opts?.projectId === "global") {
    where = "WHERE project_id IS NULL";
  } else if (opts?.projectId) {
    where = "WHERE project_id = ?";
    params.push(opts.projectId);
  }
  const limit = opts?.limit ?? 200;
  params.push(limit);
  return db
    .prepare(`SELECT * FROM sessions ${where} ORDER BY pinned DESC, updated_at DESC LIMIT ?`)
    .all(...params) as SessionRow[];
}

export function deleteSessionMessages(db: Database.Database, sessionId: string): number {
  return db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId).changes;
}

/**
 * Hide every visible message in a session under one compaction number, the way
 * `rewindSession` hides a tail. The rows stay; `getSessionMessages` skips them.
 *
 * Returns the batch number so the caller can name it in an event and hand it to
 * {@link restoreCompactedMessages}.
 */
export function markSessionCompacted(
  db: Database.Database,
  sessionId: string,
  opts: { keepRecent?: number } = {},
): { batch: number; hidden: number } {
  const latest = db.prepare("SELECT MAX(compacted_batch) AS batch FROM messages WHERE session_id = ?").get(sessionId) as
    | { batch: number | null }
    | undefined;
  const batch = (latest?.batch ?? 0) + 1;

  // `keepRecent` leaves the newest N visible messages alone. The cut lands on a
  // message boundary found by id, so a tool result never survives without the
  // assistant turn that called for it — `stripOrphanedToolMessages` would drop
  // it anyway, and a window that silently loses rows is worse than a smaller
  // one that does not.
  const keep = Math.max(0, Math.floor(opts.keepRecent ?? 0));
  let cutoff: number | null = null;
  if (keep > 0) {
    const row = db
      .prepare(
        `SELECT id FROM messages
          WHERE session_id = ? AND compacted_batch IS NULL AND rewound_batch IS NULL
          ORDER BY id DESC LIMIT 1 OFFSET ?`,
      )
      .get(sessionId, keep - 1) as { id: number } | undefined;
    // Fewer messages than the keep window: nothing is old enough to fold away.
    if (!row) return { batch, hidden: 0 };
    cutoff = row.id;
  }

  const hidden = db
    .prepare(
      `UPDATE messages SET compacted_batch = ?
        WHERE session_id = ? AND compacted_batch IS NULL AND rewound_batch IS NULL
          AND (? IS NULL OR id < ?)`,
    )
    .run(batch, sessionId, cutoff, cutoff).changes;
  return { batch, hidden };
}

/**
 * Put back one compaction. Defaults to the most recent, so undoing twice walks
 * back two steps rather than restoring everything at once.
 *
 * The summary row written in the originals' place is removed too — leaving it
 * would present a summary of the conversation alongside the conversation.
 */
export function restoreCompactedMessages(
  db: Database.Database,
  sessionId: string,
  batch?: number,
): { restored: number; batch: number } | null {
  const target =
    batch ??
    (
      db.prepare("SELECT MAX(compacted_batch) AS batch FROM messages WHERE session_id = ?").get(sessionId) as
        | { batch: number | null }
        | undefined
    )?.batch;
  if (!target) return null;

  const restored = db
    .prepare("UPDATE messages SET compacted_batch = NULL WHERE session_id = ? AND compacted_batch = ?")
    .run(sessionId, target).changes;
  if (restored === 0) return null;

  db.prepare("DELETE FROM messages WHERE session_id = ? AND compaction_summary_for = ?").run(sessionId, target);
  return { restored, batch: target };
}

/** Compactions still hidden in this session, oldest first. */
export function listCompactions(db: Database.Database, sessionId: string): Array<{ batch: number; messages: number }> {
  return db
    .prepare(
      `SELECT compacted_batch AS batch, COUNT(*) AS messages
         FROM messages WHERE session_id = ? AND compacted_batch IS NOT NULL
        GROUP BY compacted_batch ORDER BY compacted_batch`,
    )
    .all(sessionId) as Array<{ batch: number; messages: number }>;
}

/** Delete the session row + all its messages. Returns true if a row was removed. */
export function deleteSession(db: Database.Database, sessionId: string): boolean {
  db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId);
  const res = db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
  return res.changes > 0;
}

/** Count messages in a session (cheap, used for size-based summary importance). */
export function countSessionMessages(db: Database.Database, sessionId: string): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE session_id = ?").get(sessionId) as { c: number };
  return row.c;
}

/** Find sessions whose updated_at is older than the cutoff, optionally key-prefix filtered. */
export function findIdleSessions(
  db: Database.Database,
  cutoffIso: string,
  opts: { keyPrefixes?: string[]; minMessages?: number; limit?: number } = {},
): SessionRow[] {
  const clauses: string[] = ["updated_at <= ?"];
  const params: unknown[] = [cutoffIso];

  if (opts.keyPrefixes && opts.keyPrefixes.length > 0) {
    const ors = opts.keyPrefixes.map(() => "key LIKE ?").join(" OR ");
    clauses.push(`(${ors})`);
    for (const p of opts.keyPrefixes) params.push(`${p}%`);
  }

  if (opts.minMessages && opts.minMessages > 0) {
    clauses.push("(SELECT COUNT(*) FROM messages WHERE messages.session_id = sessions.id) >= ?");
    params.push(opts.minMessages);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : 50;
  return db
    .prepare(`SELECT * FROM sessions ${where} ORDER BY updated_at ASC LIMIT ?`)
    .all(...params, limit) as SessionRow[];
}

/**
 * The conversation as the model should see it.
 *
 * Rewound rows are skipped rather than deleted (see `agent/rewind.ts`), so a
 * rewind takes effect on the very next turn — history is re-read from here on
 * every round — while the transcript stays whole and the rewind stays
 * reversible.
 */
export function getSessionMessages(db: Database.Database, sessionId: string): Message[] {
  const rows = db
    .prepare(
      // Compaction summaries sort ahead of surviving messages, in batch order.
      //
      // A summary row is written last and so carries the highest id, but it
      // stands in for the *oldest* part of the conversation. With a keep-recent
      // window that put the synopsis of the distant past after the turns it
      // precedes — the model would read the ending, then a summary of the
      // beginning. Ordering on the batch instead of the id restores chronology,
      // and holds for repeated compactions because each batch only ever
      // replaces content older than everything still visible.
      `SELECT * FROM messages
        WHERE session_id = ? AND rewound_batch IS NULL AND compacted_batch IS NULL
        ORDER BY (compaction_summary_for IS NULL) ASC, compaction_summary_for ASC, id ASC`,
    )
    .all(sessionId) as MessageRow[];

  return rows.map((row) => ({
    role: row.role as Message["role"],
    content: decodeMessageContent(row.content),
    toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
    toolCallId: row.tool_call_id ?? undefined,
    reasoning: row.reasoning ?? undefined,
  }));
}
