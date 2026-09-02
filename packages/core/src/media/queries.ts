/**
 * The `media` table: metadata for stored blobs, plus the retention sweep.
 *
 * Metadata here, bytes on disk — the same split `documents` uses. The row is
 * what makes retention answerable without walking the filesystem, and what lets
 * a surface render a placeholder or an image tag without reading the payload.
 */

import type Database from "better-sqlite3";
import type { MediaRef } from "../content/types.js";

/**
 * Row helpers for the `media` table.
 *
 * Exported, not internal: a media store is a registry seam
 * ({@link import("./registry.js").registerMediaStoreFactory}), and a store
 * that cannot write this table cannot participate in the deployment. The
 * retention sweep walks `media` and calls `MediaStore.delete`, `touchMedia`
 * keeps a blob alive when a rendition of it is served, and the dashboard sums
 * `bytes` — all of which see an out-of-tree store only if that store keeps its
 * metadata here.
 *
 * The alternative is a store that invents its own table, which means its blobs
 * are invisible to retention and grow without limit, and its schema drifts from
 * core's on the next migration. Sharing the table is the contract; these are
 * how a plugin holds up its end.
 */
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

/**
 * Mark a blob as still in use, without re-storing it.
 *
 * Retention measures "unused since", and until renditions existed the only
 * thing that refreshed the clock was {@link upsertMediaRow} — putting the same
 * bytes again. Reading never counted, which was harmless while reading was the
 * only other thing anyone did.
 *
 * It stops being harmless the moment a rendition exists. The rendition is what
 * gets served from then on, so the ORIGINAL stops being touched and becomes the
 * first thing the sweep deletes — which breaks the one feature that depends on
 * the original outliving its cheap copy: an agent handed a thumbnail, spending
 * its handle an hour later on an image that is gone. Nothing fails at the time.
 * It fails a week later, on exactly the request the feature exists to serve.
 */
export function touchMedia(db: Database.Database, id: string): void {
  db.prepare("UPDATE media SET last_seen_at = datetime('now') WHERE id = ?").run(id);
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
