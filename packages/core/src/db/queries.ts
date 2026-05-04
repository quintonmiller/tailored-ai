import type Database from "better-sqlite3";
import type { Message } from "../providers/interface.js";

export interface SessionRow {
  id: string;
  key: string | null;
  model: string;
  provider: string;
  project_id: string | null;
  created_at: string;
  updated_at: string;
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
  db.prepare("INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id) VALUES (?, ?, ?, ?, ?)").run(
    sessionId,
    msg.role,
    msg.content,
    msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
    msg.toolCallId ?? null,
  );
}

export function updateSessionModelProvider(db: Database.Database, id: string, model: string, provider: string): void {
  db.prepare("UPDATE sessions SET model = ?, provider = ? WHERE id = ?").run(model, provider, id);
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
    .prepare(`SELECT * FROM sessions ${where} ORDER BY updated_at DESC LIMIT ?`)
    .all(...params) as SessionRow[];
}

export function deleteSessionMessages(db: Database.Database, sessionId: string): number {
  return db.prepare("DELETE FROM messages WHERE session_id = ?").run(sessionId).changes;
}

export function getSessionMessages(db: Database.Database, sessionId: string): Message[] {
  const rows = db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC").all(sessionId) as MessageRow[];

  return rows.map((row) => ({
    role: row.role as Message["role"],
    content: row.content,
    toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
    toolCallId: row.tool_call_id ?? undefined,
  }));
}
