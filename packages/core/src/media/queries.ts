/**
 * The `media` table: metadata for stored blobs, plus the retention sweep.
 *
 * Metadata here, bytes on disk — the same split `documents` uses. The row is
 * what makes retention answerable without walking the filesystem, and what lets
 * a surface render a placeholder or an image tag without reading the payload.
 */

import type Database from "better-sqlite3";
import type { MediaRef } from "../content/types.js";

export interface MediaRow {
  ref: MediaRef;
  path: string;
  sessionId: string | null;
  createdAt: string;
  lastSeenAt: string;
}

interface RawMediaRow {
  id: string;
  mime_type: string;
  bytes: number;
  name: string | null;
  width: number | null;
  height: number | null;
  path: string;
  session_id: string | null;
  created_at: string;
  last_seen_at: string;
}

function toRow(raw: RawMediaRow): MediaRow {
  const ref: MediaRef = {
    id: raw.id,
    mimeType: raw.mime_type,
    bytes: raw.bytes,
    ...(raw.name ? { name: raw.name } : {}),
    ...(raw.width !== null ? { width: raw.width } : {}),
    ...(raw.height !== null ? { height: raw.height } : {}),
  };
  return {
    ref,
    path: raw.path,
    sessionId: raw.session_id,
    createdAt: raw.created_at,
    lastSeenAt: raw.last_seen_at,
  };
}

export function upsertMediaRow(
  db: Database.Database,
  entry: { ref: MediaRef; path: string; sessionId: string | null },
): void {
  const { ref, path, sessionId } = entry;
  // Content-addressed ids mean a conflict is the same bytes arriving again.
  // Refresh `last_seen_at` so retention measures "unused since", not "created
  // long ago" — a screenshot re-taken every day should not expire mid-use.
  db.prepare(
    `INSERT INTO media (id, mime_type, bytes, name, width, height, path, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       last_seen_at = datetime('now'),
       name = COALESCE(excluded.name, media.name),
       session_id = COALESCE(media.session_id, excluded.session_id)`,
  ).run(ref.id, ref.mimeType, ref.bytes, ref.name ?? null, ref.width ?? null, ref.height ?? null, path, sessionId);
}

export function getMediaRow(db: Database.Database, id: string): MediaRow | undefined {
  const raw = db.prepare("SELECT * FROM media WHERE id = ?").get(id) as RawMediaRow | undefined;
  return raw ? toRow(raw) : undefined;
}

export function deleteMediaRow(db: Database.Database, id: string): void {
  db.prepare("DELETE FROM media WHERE id = ?").run(id);
}

export function listMediaRows(db: Database.Database, limit = 100): MediaRow[] {
  const raws = db.prepare("SELECT * FROM media ORDER BY last_seen_at DESC LIMIT ?").all(limit) as RawMediaRow[];
  return raws.map(toRow);
}

/**
 * Blobs untouched for longer than `retentionDays`.
 *
 * Returned rather than deleted so the caller owns the destructive half: the
 * sweep needs to remove a file *and* a row, and doing half of that inside a
 * query would leave the store inconsistent if the unlink failed.
 */
export function findExpiredMedia(db: Database.Database, retentionDays: number, limit = 500): MediaRow[] {
  const raws = db
    .prepare(
      `SELECT * FROM media
        WHERE last_seen_at < datetime('now', ?)
        ORDER BY last_seen_at ASC
        LIMIT ?`,
    )
    .all(`-${retentionDays} days`, limit) as RawMediaRow[];
  return raws.map(toRow);
}

/** Total bytes held, for a dashboard or a `tai` status line. */
export function totalMediaBytes(db: Database.Database): number {
  const row = db.prepare("SELECT COALESCE(SUM(bytes), 0) AS total FROM media").get() as { total: number };
  return row.total;
}
