/**
 * Thin adapter over `backend.query` that preserves the `RecallHit` shape
 * existing callers (RecallTool, memory injection, server routes) consume.
 *
 * Scoring lives behind the backend now — see `memory/scoring.ts` for the
 * helpers SqliteMemoryBackend uses internally. A plugin backend ranks
 * however it likes; this wrapper only translates MemoryFragment[] →
 * RecallHit[].
 */

import type { MemoryBackend, MemoryFragment } from "../memory/interface.js";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { recordNoteHit } from "../agent/memory-promotion.js";
import type Database from "better-sqlite3";

export type Tier = "short" | "long";

export interface RecallHit {
  tier: Tier;
  source: string; // note id, fact label, or chunk source
  score: number;
  snippet: string;
  createdAt: string;
}

export interface RecallQueryOptions {
  query: string;
  tier?: "any" | Tier;
  projectId?: string | null;
  limit?: number;
  /** When provided, the query text is embedded once and passed to
   *  `backend.query` as `vector`. Backends that own their embedding
   *  ignore the vector and recompute internally. */
  embedder?: EmbeddingProvider;
  embedModel?: string;
  semanticMinScore?: number;
  trackRefs?: boolean;
  autoPromote?: boolean;
  promoteThreshold?: number;
}

export { tokenize, coverage } from "../memory/scoring.js";

/**
 * Async recall. Calls `backend.query` with the given context and
 * converts the returned fragments into the legacy RecallHit shape.
 *
 * When an embedder is provided the query text is embedded once and
 * passed in as `vector` so the backend can run a hybrid keyword +
 * semantic search; backends that don't honour vectors simply ignore it.
 */
export async function recallQueryAsync(
  backend: MemoryBackend,
  opts: RecallQueryOptions,
  /** SQLite escape: track ref-counts when the backend's ids match the
   *  built-in `note:` prefix. No-op for plugin backends. Optional — only
   *  used when `trackRefs` is true. */
  db?: Database.Database,
): Promise<RecallHit[]> {
  if (!opts.query.trim()) return [];

  let vector: Float32Array | undefined;
  if (opts.embedder && opts.tier !== "short") {
    try {
      const out = await opts.embedder.embed([opts.query], { model: opts.embedModel });
      vector = out.vectors[0];
    } catch (err) {
      // Semantic failures never block keyword recall — same contract as before.
      console.error("[recall] semantic search failed:", (err as Error).message);
    }
  }

  const fragments = await backend.query({
    freeText: opts.query,
    vector,
    scope: opts.projectId ? `project:${opts.projectId}` : "global",
    limit: opts.limit ?? 5,
    minImportance: opts.semanticMinScore,
  });

  const hits = fragments.map(toRecallHit).filter((h): h is RecallHit => h !== null);

  // Tier filter — when the caller restricted, drop the other tier.
  const filtered = opts.tier && opts.tier !== "any" ? hits.filter((h) => h.tier === opts.tier) : hits;

  // Ref tracking — SQLite-specific lifecycle nudge. Stays here until
  // Phase 3 moves it inside the backend or removes it entirely.
  if (db && opts.trackRefs) {
    for (const h of filtered) {
      if (h.tier !== "short") continue;
      if (!h.source.startsWith("note_")) continue;
      recordNoteHit(db, h.source, {
        embedder: opts.autoPromote ? opts.embedder : undefined,
        threshold: opts.promoteThreshold,
      });
    }
  }

  return filtered;
}

/**
 * Sync-compatible recall — kept as an alias for legacy callers. Always
 * resolves; the underlying `backend.query` is async so this returns a
 * promise. Update call sites to `await` and prefer `recallQueryAsync`.
 *
 * @deprecated use `recallQueryAsync` directly.
 */
export const recallQuery = recallQueryAsync;

function toRecallHit(f: MemoryFragment): RecallHit | null {
  const md = f.metadata ?? {};
  const kind = typeof md.kind === "string" ? md.kind : "note";
  const score = typeof md.score === "number" ? md.score : 0;
  const createdAt =
    typeof md.created_at === "string"
      ? md.created_at
      : typeof md.updated_at === "string"
        ? md.updated_at
        : new Date().toISOString();
  const snippet = typeof md.snippet === "string" ? md.snippet : oneLine(f.text);

  if (kind === "fact") {
    const label = typeof md.label === "string" ? md.label : (f.id ?? "");
    return { tier: "long", source: label, score, snippet, createdAt };
  }
  if (kind === "chunk") {
    const source = typeof md.source === "string" ? md.source : (f.id ?? "");
    return { tier: "long", source, score, snippet, createdAt };
  }
  if (kind === "note") {
    // Strip the `note:` prefix from the fragment id so legacy callers
    // that index by raw note id keep working.
    const idStr = typeof f.id === "string" ? f.id : "";
    const source = idStr.startsWith("note:") ? idStr.slice("note:".length) : idStr;
    return { tier: "short", source, score, snippet, createdAt };
  }
  return null;
}

function oneLine(s: string): string {
  const line = s.split("\n")[0] ?? "";
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

export function formatHits(hits: RecallHit[]): string {
  if (hits.length === 0) return "(no matches)";
  const lines: string[] = [];
  for (const h of hits) {
    const score = h.score.toFixed(2);
    lines.push(`[${score}] ${h.tier.padEnd(5)} ${h.source}\n  ${h.snippet}`);
  }
  lines.push(`(${hits.length} ${hits.length === 1 ? "result" : "results"})`);
  return lines.join("\n");
}
