import type Database from "better-sqlite3";
import {
  countChunks,
  deleteChunksBySource,
  listChunksBySource,
} from "../db/chunk-queries.js";
import {
  extendNoteTtl,
  getNote,
  incrementNoteRef,
  sweepExpiredNotes,
  type Note,
} from "../db/note-queries.js";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { indexNote, type ChunkOptions } from "./memory-index.js";

const DEFAULT_PROMOTE_THRESHOLD = 3;
const DEFAULT_TTL_EXTEND_DAYS = 7;

export interface PromoteOptions extends ChunkOptions {
  /** Force re-indexing even if chunks already exist. Default false. */
  force?: boolean;
  /** Override the embed model. */
  model?: string;
}

export interface PromoteResult {
  noteId: string;
  chunkCount: number;
  alreadyPromoted: boolean;
}

/**
 * Clone a note into memory_chunks so semantic search can find it. Idempotent:
 * the second call is a no-op (alreadyPromoted=true) unless force is set.
 * See docs/memory-tiers.md (M6).
 */
export async function promoteNote(
  db: Database.Database,
  embedder: EmbeddingProvider,
  noteId: string,
  opts: PromoteOptions = {},
): Promise<PromoteResult | null> {
  const note = getNote(db, noteId);
  if (!note) return null;

  const source = `note:${note.id}`;
  const existing = listChunksBySource(db, source);
  if (existing.length > 0 && !opts.force) {
    return { noteId: note.id, chunkCount: existing.length, alreadyPromoted: true };
  }
  if (opts.force) deleteChunksBySource(db, source);

  const result = await indexNote(db, embedder, note, {
    maxChunkChars: opts.maxChunkChars,
    overlap: opts.overlap,
    model: opts.model,
  });
  return { noteId: note.id, chunkCount: result.chunkCount, alreadyPromoted: false };
}

/**
 * Track a note hit: increment ref_count and, when the threshold is reached
 * AND an embedder is available AND no chunks exist yet, fire-and-forget
 * `promoteNote`. Returns the new ref_count (null if the note vanished).
 */
export function recordNoteHit(
  db: Database.Database,
  noteId: string,
  opts: {
    embedder?: EmbeddingProvider;
    threshold?: number;
    onPromote?: (result: PromoteResult) => void;
  } = {},
): number | null {
  const count = incrementNoteRef(db, noteId);
  if (count === null) return null;

  const threshold = opts.threshold ?? DEFAULT_PROMOTE_THRESHOLD;
  if (count >= threshold && opts.embedder) {
    const source = `note:${noteId}`;
    const existing = listChunksBySource(db, source).length;
    if (existing === 0) {
      // Fire-and-forget; failures shouldn't break the hot path.
      void promoteNote(db, opts.embedder, noteId)
        .then((res) => {
          if (res && opts.onPromote) opts.onPromote(res);
        })
        .catch((err) => {
          console.error("[memory-promotion] auto-promote failed:", (err as Error).message);
        });
    }
  }
  return count;
}

export interface SweepOptions {
  /** Importance floor for keeping past-TTL notes. Default 0.8. */
  keepImportance?: number;
  /** Extend TTL on notes whose ref_count >= this. Default 3. */
  refExtendThreshold?: number;
  /** How many days to add. Default 7. */
  extendDays?: number;
}

export interface SweepReport {
  deletedExpired: number;
  extendedTtl: number;
  remainingNotes: number;
  totalChunks: number;
}

/**
 * Daily memory hygiene pass:
 *   1. Extend TTLs on referenced notes (so churn-worthy work survives).
 *   2. Delete expired low-importance notes.
 *   3. Return counts for telemetry.
 *
 * Idempotent. Safe to call repeatedly. Order matters: extend before delete
 * so a referenced-but-expiring note gets its lease renewed.
 */
export function runMemorySweep(
  db: Database.Database,
  opts: SweepOptions = {},
): SweepReport {
  const refThreshold = opts.refExtendThreshold ?? DEFAULT_PROMOTE_THRESHOLD;
  const extendDays = opts.extendDays ?? DEFAULT_TTL_EXTEND_DAYS;

  let extendedTtl = 0;
  // Pull notes nearing expiry with high ref_count — small candidate set in practice.
  const rows = db
    .prepare(
      `SELECT id FROM notes
       WHERE ttl_at IS NOT NULL
         AND ref_count >= ?
         AND datetime(ttl_at) <= datetime('now', '+1 day')`,
    )
    .all(refThreshold) as Array<{ id: string }>;
  for (const r of rows) {
    if (extendNoteTtl(db, r.id, extendDays)) extendedTtl++;
  }

  const deletedExpired = sweepExpiredNotes(db, opts.keepImportance);
  const remainingNotes = (db
    .prepare("SELECT COUNT(*) AS c FROM notes")
    .get() as { c: number }).c;
  const totalChunks = countChunks(db);

  return { deletedExpired, extendedTtl, remainingNotes, totalChunks };
}

export const __TEST_HOOK__ = { DEFAULT_PROMOTE_THRESHOLD, DEFAULT_TTL_EXTEND_DAYS };

/** Used by recordNoteHit for tests / callers that want to wait on the promotion. */
export function buildPromotionWaiter(): {
  promise: Promise<PromoteResult | null>;
  onPromote: (r: PromoteResult) => void;
} {
  let resolve: (r: PromoteResult | null) => void = () => {};
  const promise = new Promise<PromoteResult | null>((res) => {
    resolve = res;
  });
  return {
    promise,
    onPromote: (r) => resolve(r),
  };
}
