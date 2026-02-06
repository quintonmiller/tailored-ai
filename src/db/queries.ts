import type Database from 'better-sqlite3';
import type { Message } from '../providers/interface.js';

export interface SessionRow {
  id: string;
  key: string | null;
  model: string;
  provider: string;
  created_at: string;
  updated_at: string;
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
  key?: string
): void {
  db.prepare(
    'INSERT INTO sessions (id, key, model, provider) VALUES (?, ?, ?, ?)'
  ).run(id, key ?? null, model, provider);
}

export function getSession(
  db: Database.Database,
  id: string
): SessionRow | undefined {
  return db
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .get(id) as SessionRow | undefined;
}

export function getSessionByKey(
  db: Database.Database,
  key: string
): SessionRow | undefined {
  return db
    .prepare('SELECT * FROM sessions WHERE key = ?')
    .get(key) as SessionRow | undefined;
}

export function saveMessage(
  db: Database.Database,
  sessionId: string,
  msg: Message
): void {
  db.prepare(
    'INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id) VALUES (?, ?, ?, ?, ?)'
  ).run(
    sessionId,
    msg.role,
    msg.content,
    msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
    msg.toolCallId ?? null
  );

  db.prepare(
    "UPDATE sessions SET updated_at = datetime('now') WHERE id = ?"
  ).run(sessionId);
}

export function listSessions(db: Database.Database): SessionRow[] {
  return db
    .prepare('SELECT * FROM sessions ORDER BY updated_at DESC')
    .all() as SessionRow[];
}

export function getSessionMessages(
  db: Database.Database,
  sessionId: string
): Message[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC')
    .all(sessionId) as MessageRow[];

  return rows.map((row) => ({
    role: row.role as Message['role'],
    content: row.content,
    toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
    toolCallId: row.tool_call_id ?? undefined,
  }));
}
