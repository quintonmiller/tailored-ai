import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

/**
 * A short-term memory note: free-form prose the agent writes during a
 * session. Notes have optional TTL and importance for retention policy.
 * See docs/memory-tiers.md for the full design.
 */
export interface Note {
  id: string;
  session_id: string | null;
  project_id: string | null;
  agent: string | null;
  content: string;
  tags: string[];
  importance: number | null;
  created_at: string;
  ttl_at: string | null;
}

export interface NoteInput {
  content: string;
  session_id?: string | null;
  project_id?: string | null;
  agent?: string | null;
  tags?: string[];
  importance?: number | null;
  ttl_at?: string | null;
}

export interface NoteQuery {
  project_id?: string | null;
  session_id?: string | null;
  agent?: string | null;
  tag?: string;
  search?: string;
  limit?: number;
  /** When true, exclude notes whose ttl_at has passed. */
  excludeExpired?: boolean;
}

interface NoteRow {
  id: string;
  session_id: string | null;
  project_id: string | null;
  agent: string | null;
  content: string;
  tags: string;
  importance: number | null;
  created_at: string;
  ttl_at: string | null;
}

function rowToNote(row: NoteRow): Note {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags);
    if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === "string");
  } catch {
    // tolerate malformed JSON
  }
  return { ...row, tags };
}

export function createNote(db: Database.Database, input: NoteInput): Note {
  const id = `note_${randomUUID().slice(0, 8)}`;
  const tags = JSON.stringify(input.tags ?? []);
  db.prepare(
    `INSERT INTO notes (id, session_id, project_id, agent, content, tags, importance, ttl_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.session_id ?? null,
    input.project_id ?? null,
    input.agent ?? null,
    input.content,
    tags,
    input.importance ?? null,
    input.ttl_at ?? null,
  );
  return getNote(db, id)!;
}

export function getNote(db: Database.Database, id: string): Note | null {
  const row = db.prepare("SELECT * FROM notes WHERE id = ?").get(id) as NoteRow | undefined;
  return row ? rowToNote(row) : null;
}

export function listNotes(db: Database.Database, q: NoteQuery = {}): Note[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (q.project_id !== undefined) {
    if (q.project_id === null) {
      clauses.push("project_id IS NULL");
    } else {
      clauses.push("project_id = ?");
      params.push(q.project_id);
    }
  }
  if (q.session_id !== undefined) {
    if (q.session_id === null) {
      clauses.push("session_id IS NULL");
    } else {
      clauses.push("session_id = ?");
      params.push(q.session_id);
    }
  }
  if (q.agent !== undefined) {
    if (q.agent === null) {
      clauses.push("agent IS NULL");
    } else {
      clauses.push("agent = ?");
      params.push(q.agent);
    }
  }
  if (q.tag) {
    // tags is a JSON array — use json_each to filter.
    clauses.push("EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE json_each.value = ?)");
    params.push(q.tag);
  }
  if (q.search) {
    clauses.push("content LIKE ?");
    params.push(`%${q.search}%`);
  }
  if (q.excludeExpired) {
    // Normalize via datetime() — TTLs are written as ISO 8601 strings with T/Z,
    // while datetime('now') returns SQLite's own format (no T, no Z).
    clauses.push("(ttl_at IS NULL OR datetime(ttl_at) > datetime('now'))");
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = q.limit && q.limit > 0 ? `LIMIT ${Math.floor(q.limit)}` : "";
  const sql = `SELECT * FROM notes ${where} ORDER BY created_at DESC ${limit}`;
  return (db.prepare(sql).all(...params) as NoteRow[]).map(rowToNote);
}

export function deleteNote(db: Database.Database, id: string): boolean {
  const res = db.prepare("DELETE FROM notes WHERE id = ?").run(id);
  return res.changes > 0;
}

/** Delete notes whose ttl_at has passed unless importance >= keepThreshold. */
export function sweepExpiredNotes(db: Database.Database, keepImportance = 0.8): number {
  const res = db
    .prepare(
      `DELETE FROM notes
       WHERE ttl_at IS NOT NULL
         AND datetime(ttl_at) <= datetime('now')
         AND (importance IS NULL OR importance < ?)`,
    )
    .run(keepImportance);
  return res.changes;
}
