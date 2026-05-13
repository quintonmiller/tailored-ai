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
  ).run(
    id,
    input.project_id ?? null,
    input.source,
    input.content,
    embeddingBuf,
    input.embed_model ?? null,
    metadata,
  );
  return getChunk(db, id)!;
}

export function getChunk(db: Database.Database, id: string): MemoryChunk | null {
  const row = db.prepare("SELECT * FROM memory_chunks WHERE id = ?").get(id) as ChunkRow | undefined;
  return row ? rowToChunk(row) : null;
}

export function listChunksBySource(db: Database.Database, source: string): MemoryChunk[] {
  return (db
    .prepare("SELECT * FROM memory_chunks WHERE source = ? ORDER BY created_at ASC")
    .all(source) as ChunkRow[]).map(rowToChunk);
}

export function deleteChunksBySource(db: Database.Database, source: string): number {
  return db.prepare("DELETE FROM memory_chunks WHERE source = ?").run(source).changes;
}

export function countChunks(db: Database.Database, projectId?: string | null): number {
  if (projectId === undefined) {
    const r = db.prepare("SELECT COUNT(*) AS c FROM memory_chunks").get() as { c: number };
    return r.c;
  }
  const r = db
    .prepare(
      projectId === null
        ? "SELECT COUNT(*) AS c FROM memory_chunks WHERE project_id IS NULL"
        : "SELECT COUNT(*) AS c FROM memory_chunks WHERE project_id = ?",
    )
    .get(...(projectId === null ? [] : [projectId])) as { c: number };
  return r.c;
}

export interface ChunkSearchHit {
  chunk: MemoryChunk;
  score: number; // cosine similarity ∈ [-1, 1], typically [0, 1] for normalized embeddings
}

/**
 * Brute-force cosine search across all chunks in scope. Acceptable up to a
 * few thousand chunks; revisit when the corpus grows past ~10k.
 */
export function semanticSearch(
  db: Database.Database,
  query: Float32Array,
  opts: { projectId?: string | null; limit?: number; minScore?: number } = {},
): ChunkSearchHit[] {
  const limit = opts.limit ?? 5;
  const minScore = opts.minScore ?? 0;

  const clauses: string[] = ["embedding IS NOT NULL"];
  const params: unknown[] = [];
  if (opts.projectId !== undefined) {
    if (opts.projectId === null) {
      clauses.push("project_id IS NULL");
    } else {
      clauses.push("project_id = ?");
      params.push(opts.projectId);
    }
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const rows = db.prepare(`SELECT * FROM memory_chunks ${where}`).all(...params) as ChunkRow[];

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
