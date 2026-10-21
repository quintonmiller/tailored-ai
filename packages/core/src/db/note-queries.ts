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
  /**
   * Never swept: set by `recall action="keep"`. Stored in the `archival`
   * column, which is named for an older meaning and is NOT the archive.
   */
  kept: boolean;
  /** When the note was archived (hidden), or null while it is live. */
  archived_at: string | null;
  /** Who archived it: an agent's name, `sweep`, or `owner` for a person. */
  archived_by: string | null;
  archive_reason: string | null;
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
  /**
   * With a named `agent`, also return notes no agent claimed. Notes predating
   * authorship, or written by an unnamed session, have a null `agent`; a
   * strict match would hide all of them from everyone.
   */
  includeUnowned?: boolean;
  tag?: string;
  search?: string;
  limit?: number;
  /**
   * When true, exclude live notes whose ttl_at has passed. Archived notes
   * that `includeArchived` asks for come back regardless: the sweep archives
   * notes because they expired, so filtering those by expiry would hide every
   * one of them from the archive view.
   */
  excludeExpired?: boolean;
  /**
   * When true AND project_id is a specific project id, also return notes
   * where project_id IS NULL (globals). Mirrors the inheritance behavior
   * already used by listPinnedNotes — a project view sees its own notes
   * + global ones, since global preferences/facts apply everywhere.
   */
  includeGlobal?: boolean;
  /** Also return archived notes. Off by default: archived means hidden. */
  includeArchived?: boolean;
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
  archival: number;
  archived_at: string | null;
  archived_by: string | null;
  archive_reason: string | null;
}

function rowToNote(row: NoteRow): Note {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags);
    if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === "string");
  } catch {
    // tolerate malformed JSON
  }
  const { archival, ...rest } = row;
  return { ...rest, tags, kept: archival === 1 };
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
    } else if (q.includeGlobal) {
      clauses.push("(project_id = ? OR project_id IS NULL)");
      params.push(q.project_id);
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
    } else if (q.includeUnowned) {
      // An agent's own notes plus the ones nobody claimed — the same shape as
      // the project filter above, and for the same reason. Notes written
      // before authorship was recorded, or by an unnamed session, have a null
      // `agent`; a strict `agent = ?` would make every one of them invisible
      // to everybody, which is a worse failure than the one being fixed.
      clauses.push("(agent = ? OR agent IS NULL)");
      params.push(q.agent);
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
  if (q.excludeExpired) clauses.push(liveUnexpired(q.includeArchived));
  if (!q.includeArchived) clauses.push("archived_at IS NULL");

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = q.limit && q.limit > 0 ? `LIMIT ${Math.floor(q.limit)}` : "";
  // SQLite's `datetime('now')` is second-precision, so bursts of notes written
  // in the same second tie on `created_at`. The previous tiebreak — `id DESC`,
  // where the id is `note_${randomHex}` — is *not* monotonic in insertion
  // order, so two notes written within the same second came back in arbitrary
  // order (#63). `rowid` is SQLite's implicit monotonic insertion counter and
  // gives us deterministic newest-first ordering at sub-second precision.
  const sql = `SELECT * FROM notes ${where} ORDER BY created_at DESC, rowid DESC ${limit}`;
  return (db.prepare(sql).all(...params) as NoteRow[]).map(rowToNote);
}

/**
 * The expiry filter. Normalized via datetime(): TTLs are written as ISO 8601
 * strings with T/Z, while datetime('now') returns SQLite's own format (no T,
 * no Z). With archived notes in the result it applies to live notes only.
 */
function liveUnexpired(includeArchived: boolean | undefined): string {
  const unexpired = "ttl_at IS NULL OR datetime(ttl_at) > datetime('now')";
  return includeArchived ? `(archived_at IS NOT NULL OR ${unexpired})` : `(${unexpired})`;
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
  /** Restrict to one agent's pinned notes plus unowned ones. */
  agent?: string;
  limit?: number;
  pinnedImportance?: number;
  excludeExpired?: boolean;
  /** Also return archived notes. Off by default: an archived note never injects. */
  includeArchived?: boolean;
}

export function listPinnedNotes(db: Database.Database, q: PinnedNotesQuery = {}): Note[] {
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
  if (q.agent) {
    clauses.push("(agent = ? OR agent IS NULL)");
    params.push(q.agent);
  }
  const pinnedImportance = q.pinnedImportance ?? 0.95;
  clauses.push("(EXISTS (SELECT 1 FROM json_each(notes.tags) WHERE json_each.value = 'pinned') OR importance >= ?)");
  params.push(pinnedImportance);
  // Default ON — expired pinned notes shouldn't keep injecting.
  if (q.excludeExpired !== false) clauses.push(liveUnexpired(q.includeArchived));
  if (!q.includeArchived) clauses.push("archived_at IS NULL");
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

export function updateNote(db: Database.Database, id: string, patch: NotePatch): Note | null {
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

/**
 * Delete a note for good, with the search chunks promoted from it. Without the
 * chunks going too, a deleted note stayed findable by semantic search under
 * its old text. This is a person's delete; agents and the sweep archive.
 */
export function deleteNote(db: Database.Database, id: string): boolean {
  return db.transaction(() => {
    const res = db.prepare("DELETE FROM notes WHERE id = ?").run(id);
    if (res.changes > 0) db.prepare("DELETE FROM memory_chunks WHERE source = ?").run(`note:${id}`);
    return res.changes > 0;
  })();
}

/**
 * Hide a note without deleting it. It drops out of recall, injection and
 * lists, and so do the chunks promoted from it, until {@link unarchiveNote}.
 *
 * Idempotent: archiving an archived note leaves its original stamp, so "when
 * and why did this go?" keeps its first answer. Returns the note (archived
 * either way), or null when there is no such note.
 */
export function archiveNote(
  db: Database.Database,
  id: string,
  opts: { by?: string | null; reason?: string | null } = {},
): Note | null {
  db.prepare(
    `UPDATE notes SET archived_at = datetime('now'), archived_by = ?, archive_reason = ?
      WHERE id = ? AND archived_at IS NULL`,
  ).run(opts.by ?? null, opts.reason ?? null, id);
  return getNote(db, id);
}

/** Bring an archived note back exactly as it was. Null when there is no such note. */
export function unarchiveNote(db: Database.Database, id: string): Note | null {
  db.prepare("UPDATE notes SET archived_at = NULL, archived_by = NULL, archive_reason = NULL WHERE id = ?").run(id);
  return getNote(db, id);
}

/**
 * Mark a note kept: the sweep never touches it, however old it gets. The
 * reason goes on as a `keep: <reason>` tag so the Memory page can say why.
 * Idempotent. Null when there is no such note.
 */
export function keepNote(db: Database.Database, id: string, reason: string): Note | null {
  db.prepare("UPDATE notes SET archival = 1, tags = json_insert(tags, '$[#]', ?) WHERE id = ? AND archival = 0").run(
    `keep: ${reason}`,
    id,
  );
  return getNote(db, id);
}

/**
 * Increment a note's ref_count. Used as the auto-promotion signal — every
 * time a note is surfaced by recall, this ticks up. Returns the new count
 * (or null if the note doesn't exist or is archived).
 *
 * An archived note only surfaces when someone asks for archived notes, which
 * is a look back rather than use, so it neither counts nor gets promoted.
 */
export function incrementNoteRef(db: Database.Database, id: string): number | null {
  const res = db
    .prepare("UPDATE notes SET ref_count = ref_count + 1 WHERE id = ? AND archived_at IS NULL RETURNING ref_count")
    .get(id) as { ref_count: number } | undefined;
  return res?.ref_count ?? null;
}

/**
 * Extend a note's ttl_at by N days. No-op when the note has no TTL set
 * (durable note). Returns the new ttl_at string or null when unchanged.
 */
export function extendNoteTtl(db: Database.Database, id: string, extraDays: number): string | null {
  const note = getNote(db, id);
  if (!note || !note.ttl_at) return null;
  const newTtl = new Date(new Date(note.ttl_at).getTime() + extraDays * 86_400_000).toISOString();
  db.prepare("UPDATE notes SET ttl_at = ? WHERE id = ?").run(newTtl, id);
  return newTtl;
}

/**
 * Archive notes whose ttl_at has passed, unless they are kept or their
 * importance is at least `keepImportance`. Returns how many were archived.
 *
 * Archived, not deleted: `archived_by` is `sweep` and the reason `expired`,
 * so an expired note someone still wanted can be found and brought back.
 */
export function sweepExpiredNotes(db: Database.Database, keepImportance = 0.8): number {
  const res = db
    .prepare(
      `UPDATE notes SET archived_at = datetime('now'), archived_by = 'sweep', archive_reason = 'expired'
       WHERE ttl_at IS NOT NULL
         AND datetime(ttl_at) <= datetime('now')
         AND (importance IS NULL OR importance < ?)
         AND archival = 0
         AND archived_at IS NULL`,
    )
    .run(keepImportance);
  return res.changes;
}
