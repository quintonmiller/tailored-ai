import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type Database from "better-sqlite3";
import { createChunk, deleteChunksBySource } from "../db/chunk-queries.js";
import type { Note } from "../db/note-queries.js";
import type { EmbeddingProvider } from "../providers/embedding.js";

export interface IndexResult {
  source: string;
  chunkCount: number;
}

export interface ChunkOptions {
  maxChunkChars?: number;
  overlap?: number;
}

const DEFAULT_MAX_CHARS = 1500;
const DEFAULT_OVERLAP = 100;

/**
 * Split a long string into overlapping windows. Cheap heuristic; deliberately
 * not paragraph-aware so it works on free-form notes as well as KB docs.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const max = opts.maxChunkChars ?? DEFAULT_MAX_CHARS;
  const overlap = Math.min(opts.overlap ?? DEFAULT_OVERLAP, Math.floor(max / 2));
  const cleaned = text.trim();
  if (cleaned.length === 0) return [];
  if (cleaned.length <= max) return [cleaned];

  const chunks: string[] = [];
  const step = Math.max(1, max - overlap);
  for (let i = 0; i < cleaned.length; i += step) {
    chunks.push(cleaned.slice(i, i + max));
    if (i + max >= cleaned.length) break;
  }
  return chunks;
}

/**
 * Embed and store one note. Idempotent — replaces any existing chunks with
 * source = `note:<id>`. Returns the new chunk count.
 */
export async function indexNote(
  db: Database.Database,
  embedder: EmbeddingProvider,
  note: Note,
  opts: ChunkOptions & { model?: string } = {},
): Promise<IndexResult> {
  const source = `note:${note.id}`;
  deleteChunksBySource(db, source);

  const pieces = chunkText(note.content, opts);
  if (pieces.length === 0) return { source, chunkCount: 0 };

  const result = await embedder.embed(pieces, { model: opts.model });
  for (let i = 0; i < pieces.length; i++) {
    createChunk(db, {
      source,
      content: pieces[i],
      project_id: note.project_id ?? null,
      embedding: result.vectors[i],
      embed_model: result.model,
      metadata: { noteId: note.id, idx: i, total: pieces.length },
    });
  }
  return { source, chunkCount: pieces.length };
}

/**
 * Index every .md file under a knowledge-base directory. Re-running replaces
 * each file's chunks atomically (delete-then-insert per source). Returns one
 * IndexResult per file processed; files outside .md are ignored.
 */
export async function indexKbDir(
  db: Database.Database,
  embedder: EmbeddingProvider,
  kbDir: string,
  opts: ChunkOptions & { projectId?: string | null; model?: string; signal?: AbortSignal } = {},
): Promise<IndexResult[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(kbDir);
  } catch {
    return [];
  }
  const out: IndexResult[] = [];
  for (const file of entries) {
    if (opts.signal?.aborted) break;
    if (extname(file).toLowerCase() !== ".md") continue;
    try {
      const content = await readFile(join(kbDir, file), "utf-8");
      const source = `kb:${file}`;
      deleteChunksBySource(db, source);
      const pieces = chunkText(content, opts);
      if (pieces.length === 0) {
        out.push({ source, chunkCount: 0 });
        continue;
      }
      const result = await embedder.embed(pieces, { model: opts.model, signal: opts.signal });
      for (let i = 0; i < pieces.length; i++) {
        createChunk(db, {
          source,
          content: pieces[i],
          project_id: opts.projectId ?? null,
          embedding: result.vectors[i],
          embed_model: result.model,
          metadata: { file, idx: i, total: pieces.length },
        });
      }
      out.push({ source, chunkCount: pieces.length });
    } catch (err) {
      console.error(`[memory-index] failed to index ${file}:`, (err as Error).message);
    }
  }
  return out;
}
