import type Database from "better-sqlite3";
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

export function saveMessage(db: Database.Database, sessionId: string, msg: Message): void {
  db.prepare(
    "INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, reasoning) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    sessionId,
    msg.role,
    msg.content,
    msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
    msg.toolCallId ?? null,
    msg.reasoning ?? null,
  );
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

export function getSessionMessages(db: Database.Database, sessionId: string): Message[] {
  const rows = db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC").all(sessionId) as MessageRow[];

  return rows.map((row) => ({
    role: row.role as Message["role"],
    content: row.content,
    toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
    toolCallId: row.tool_call_id ?? undefined,
    reasoning: row.reasoning ?? undefined,
  }));
}
