import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { blobToVector, cosine, vectorToBlob } from "../providers/embedding.js";

export interface MemoryChunk {
  id: string;
  project_id: string | null;
  source: string;
  content: string;
  embedding: Float32Array | null;
  embed_model: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface MemoryChunkInput {
  source: string;
  content: string;
  project_id?: string | null;
  embedding?: Float32Array | null;
  embed_model?: string | null;
  metadata?: Record<string, unknown>;
}

interface ChunkRow {
  id: string;
  project_id: string | null;
  source: string;
  content: string;
  embedding: Buffer | null;
  embed_model: string | null;
  metadata: string;
  created_at: string;
}

function rowToChunk(row: ChunkRow): MemoryChunk {
  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(row.metadata) as Record<string, unknown>;
  } catch {
    // malformed JSON — return empty object
  }
  return {
    id: row.id,
    project_id: row.project_id,
    source: row.source,
    content: row.content,
    embedding: row.embedding ? blobToVector(row.embedding) : null,
    embed_model: row.embed_model,
    metadata,
    created_at: row.created_at,
  };
}

export function createChunk(db: Database.Database, input: MemoryChunkInput): MemoryChunk {
  const id = `mc_${randomUUID().slice(0, 8)}`;
  const embeddingBuf = input.embedding ? vectorToBlob(input.embedding) : null;
  const metadata = JSON.stringify(input.metadata ?? {});
  db.prepare(
    `INSERT INTO memory_chunks (id, project_id, source, content, embedding, embed_model, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.project_id ?? null, input.source, input.content, embeddingBuf, input.embed_model ?? null, metadata);
  return getChunk(db, id)!;
}

export function getChunk(db: Database.Database, id: string): MemoryChunk | null {
  const row = db.prepare("SELECT * FROM memory_chunks WHERE id = ?").get(id) as ChunkRow | undefined;
  return row ? rowToChunk(row) : null;
}

export function listChunksBySource(db: Database.Database, source: string): MemoryChunk[] {
  return (
    db.prepare("SELECT * FROM memory_chunks WHERE source = ? ORDER BY created_at ASC").all(source) as ChunkRow[]
  ).map(rowToChunk);
}

export function deleteChunksBySource(db: Database.Database, source: string): number {
  return db.prepare("DELETE FROM memory_chunks WHERE source = ?").run(source).changes;
}

/**
 * Which chunks a read may see. A chunk promoted from a note (`source` is
 * `note:<id>`) follows that note: it surfaces only while the note exists and
 * is live. Chunks from anywhere else (a KB file) are unaffected.
 */
export interface ChunkVisibility {
  /** undefined = every project, null = global only, id = that project. */
  projectId?: string | null;
  /** Also see chunks of archived notes. A deleted note's chunks never surface. */
  includeArchived?: boolean;
}

/**
 * The FROM and WHERE for a chunk read under {@link ChunkVisibility}. The note
 * filter is a join on the note itself rather than a copy of its state on the
 * chunk, so archiving, restoring or deleting a note can't leave its chunks
 * saying something else.
 */
function visibleChunks(v: ChunkVisibility, extra: string[] = []): { sql: string; params: unknown[] } {
  const clauses = [...extra];
  const params: unknown[] = [];
  if (v.projectId !== undefined) {
    if (v.projectId === null) {
      clauses.push("c.project_id IS NULL");
    } else {
      clauses.push("c.project_id = ?");
      params.push(v.projectId);
    }
  }
  const live = v.includeArchived ? "n.id IS NOT NULL" : "n.id IS NOT NULL AND n.archived_at IS NULL";
  clauses.push(`(substr(c.source, 1, 5) != 'note:' OR (${live}))`);
  return {
    sql: `FROM memory_chunks c
          LEFT JOIN notes n ON substr(c.source, 1, 5) = 'note:' AND n.id = substr(c.source, 6)
          WHERE ${clauses.join(" AND ")}`,
    params,
  };
}

/**
 * How many chunks can surface: chunks of archived or deleted notes are left
 * out unless `includeArchived` (which still leaves out a deleted note's).
 */
export function countChunks(
  db: Database.Database,
  projectId?: string | null,
  opts: Omit<ChunkVisibility, "projectId"> = {},
): number {
  const { sql, params } = visibleChunks({ ...opts, projectId });
  const r = db.prepare(`SELECT COUNT(*) AS c ${sql}`).get(...params) as { c: number };
  return r.c;
}

/** Newest-first page of the chunks a read may see. */
export function listChunks(
  db: Database.Database,
  opts: ChunkVisibility & { limit?: number; offset?: number } = {},
): MemoryChunk[] {
  const { sql, params } = visibleChunks(opts);
  const rows = db
    .prepare(`SELECT c.* ${sql} ORDER BY c.created_at DESC, c.rowid DESC LIMIT ? OFFSET ?`)
    .all(...params, opts.limit ?? 100, opts.offset ?? 0) as ChunkRow[];
  return rows.map(rowToChunk);
}

export interface ChunkSearchHit {
  chunk: MemoryChunk;
  score: number; // cosine similarity ∈ [-1, 1], typically [0, 1] for normalized embeddings
}

/**
 * Brute-force cosine search across the chunks a read may see (see
 * {@link ChunkVisibility}): a chunk promoted from a note follows that note's
 * archive state, so archiving the note hides what was promoted from it too.
 * Acceptable up to a few thousand chunks; revisit when the corpus grows past
 * ~10k.
 */
export function semanticSearch(
  db: Database.Database,
  query: Float32Array,
  opts: ChunkVisibility & { limit?: number; minScore?: number } = {},
): ChunkSearchHit[] {
  const limit = opts.limit ?? 5;
  const minScore = opts.minScore ?? 0;

  const { sql, params } = visibleChunks(opts, ["c.embedding IS NOT NULL"]);
  const rows = db.prepare(`SELECT c.* ${sql}`).all(...params) as ChunkRow[];

  const hits: ChunkSearchHit[] = [];
  for (const row of rows) {
    const chunk = rowToChunk(row);
    if (!chunk.embedding) continue;
    const score = cosine(query, chunk.embedding);
    if (score >= minScore) hits.push({ chunk, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}
