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
  ref_count: number;
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
  ref_count: number;
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

/**
 * Notes that should ALWAYS inject into the system prompt — either explicitly
 * tagged `pinned` or with `importance >= pinnedImportance` (default 0.95).
 * Ordered by importance / ref_count / recency. Used by memory-inject's
 * pinned tier (see docs/memory.md).
 *
 * Project scoping mirrors listNotes:
 *   - omitted        → no filter (across all projects + global)
 *   - explicit null  → global only
 *   - id string      → that project's notes only
 */
export interface PinnedNotesQuery {
  project_id?: string | null;
  limit?: number;
  pinnedImportance?: number;
  excludeExpired?: boolean;
}

export function listPinnedNotes(
  db: Database.Database,
  q: PinnedNotesQuery = {},
): Note[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (q.project_id !== undefined) {
    if (q.project_id === null) {
      clauses.push("project_id IS NULL");
    } else {
      // Project-scoped notes plus global ones — global rules apply everywhere.
      clauses.push("(project_id = ? OR project_id IS NULL)");
      params.push(q.project_id);
    }
  }
  const pinnedImportance = q.pinnedImportance ?? 0.95;
  clauses.push(
    "(EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE json_each.value = 'pinned') OR importance >= ?)",
  );
  params.push(pinnedImportance);
  if (q.excludeExpired !== false) {
    // Default ON — expired pinned notes shouldn't keep injecting.
    clauses.push("(ttl_at IS NULL OR datetime(ttl_at) > datetime('now'))");
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const limit = q.limit && q.limit > 0 ? `LIMIT ${Math.floor(q.limit)}` : "LIMIT 10";
  const sql = `SELECT * FROM notes ${where}
               ORDER BY importance DESC, ref_count DESC, created_at DESC
               ${limit}`;
  return (db.prepare(sql).all(...params) as NoteRow[]).map(rowToNote);
}

/**
 * Patch a note's tags and/or importance. Used by the Memory UI's pin
 * toggle and any future curation surfaces. Returns the updated note, or
 * null when the id doesn't exist.
 */
export interface NotePatch {
  tags?: string[];
  importance?: number | null;
}

export function updateNote(
  db: Database.Database,
  id: string,
  patch: NotePatch,
): Note | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.tags !== undefined) {
    sets.push("tags = ?");
    params.push(JSON.stringify(patch.tags));
  }
  if (patch.importance !== undefined) {
    sets.push("importance = ?");
    params.push(patch.importance);
  }
  if (sets.length > 0) {
    params.push(id);
    db.prepare(`UPDATE notes SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  }
  return getNote(db, id);
}

export function deleteNote(db: Database.Database, id: string): boolean {
  const res = db.prepare("DELETE FROM notes WHERE id = ?").run(id);
  return res.changes > 0;
}

/**
 * Increment a note's ref_count. Used as the auto-promotion signal — every
 * time a note is surfaced by recall, this ticks up. Returns the new count
 * (or null if the note doesn't exist).
 */
export function incrementNoteRef(db: Database.Database, id: string): number | null {
  const res = db
    .prepare("UPDATE notes SET ref_count = ref_count + 1 WHERE id = ? RETURNING ref_count")
    .get(id) as { ref_count: number } | undefined;
  return res?.ref_count ?? null;
}

/**
 * Extend a note's ttl_at by N days. No-op when the note has no TTL set
 * (durable note). Returns the new ttl_at string or null when unchanged.
 */
export function extendNoteTtl(
  db: Database.Database,
  id: string,
  extraDays: number,
): string | null {
  const note = getNote(db, id);
  if (!note || !note.ttl_at) return null;
  const newTtl = new Date(
    new Date(note.ttl_at).getTime() + extraDays * 86_400_000,
  ).toISOString();
  db.prepare("UPDATE notes SET ttl_at = ? WHERE id = ?").run(newTtl, id);
  return newTtl;
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
