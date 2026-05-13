import type Database from "better-sqlite3";
import { recordNoteHit } from "../agent/memory-promotion.js";
import { semanticSearch } from "../db/chunk-queries.js";
import { listFacts, type Fact } from "../db/fact-queries.js";
import { listNotes, type Note } from "../db/note-queries.js";
import type { EmbeddingProvider } from "../providers/embedding.js";

export type Tier = "short" | "long";

export interface RecallHit {
  tier: Tier;
  source: string;       // note id, or facts label "category:entity/key", or chunk source
  score: number;        // 0..1
  snippet: string;      // short preview of the matching content
  createdAt: string;
}

export interface RecallQueryOptions {
  query: string;
  tier?: "any" | Tier;
  projectId?: string | null;
  limit?: number;
  /** When provided, also runs a semantic search against memory_chunks and
   * merges hits into the ranked union. Failures are swallowed; semantic
   * results never block keyword results. */
  embedder?: EmbeddingProvider;
  embedModel?: string;
  /** Minimum cosine similarity to consider a chunk match (default 0.3). */
  semanticMinScore?: number;
  /** When true, ref_count is incremented on each surfaced note hit. Default false. */
  trackRefs?: boolean;
  /** When true (and embedder present), notes crossing the threshold are auto-promoted. */
  autoPromote?: boolean;
  /** ref_count threshold for auto-promotion. Default 3. */
  promoteThreshold?: number;
}

/**
 * Split a free-form query into matching terms. Lowercase, drop very short
 * tokens, dedupe.
 */
export function tokenize(query: string): string[] {
  const raw = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/u)
    .filter((t) => t.length >= 2);
  return Array.from(new Set(raw));
}

/**
 * Coverage score in [0, 1]: how many unique query terms appear as substrings
 * inside the haystack. Bias-free baseline — call sites add field bonuses.
 */
export function coverage(terms: string[], haystack: string): number {
  if (terms.length === 0) return 0;
  const hay = haystack.toLowerCase();
  let hits = 0;
  for (const t of terms) if (hay.includes(t)) hits++;
  return hits / terms.length;
}

function scoreNote(terms: string[], n: Note): number {
  const tagBlob = n.tags.join(" ");
  const base = coverage(terms, `${n.content} ${tagBlob}`);
  if (base === 0) return 0;
  // Small bonuses on top of base coverage. Scores can exceed 1.0; they're a
  // ranking signal not a probability.
  const tagBonus = tagBlob.length > 0 && coverage(terms, tagBlob) > 0 ? 0.1 : 0;
  const importanceBoost = n.importance ? Math.min(n.importance, 1) * 0.1 : 0;
  return base + tagBonus + importanceBoost;
}

function scoreFact(terms: string[], f: Fact): number {
  // Key + entity are the most specific identifiers; value matters but is
  // freer-form. Score over the joined haystack and add a small bonus when
  // a term matches the key/entity directly.
  const haystack = `${f.category} ${f.entity} ${f.key} ${f.value}`;
  const base = coverage(terms, haystack);
  if (base === 0) return 0;
  const keyHit = coverage(terms, `${f.key} ${f.entity}`);
  const keyBonus = keyHit > 0 ? 0.15 : 0;
  return base + keyBonus;
}

function noteSnippet(n: Note): string {
  const line = n.content.split("\n")[0] ?? "";
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

function factLabel(f: Fact): string {
  return f.entity ? `${f.category}:${f.entity}/${f.key}` : `${f.category}/${f.key}`;
}

function factSnippet(f: Fact): string {
  const v = f.value.length > 160 ? `${f.value.slice(0, 160)}…` : f.value;
  return `= ${v}`;
}

/**
 * Unified keyword search across notes (short-term) and facts (long-term).
 * When `embedder` is supplied, also runs a semantic search across
 * memory_chunks and merges the hits by score. Returns hits ranked by score
 * descending, ties broken by recency.
 *
 * For backwards compat, callers can keep using `recallQuery` synchronously
 * — when no embedder is passed, the function is fully synchronous-equivalent.
 * To opt into semantic search, use `recallQueryAsync`.
 */
export function recallQuery(db: Database.Database, opts: RecallQueryOptions): RecallHit[] {
  const terms = tokenize(opts.query);
  if (terms.length === 0) return [];

  const tier = opts.tier ?? "any";
  const projectId = opts.projectId ?? null;
  const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : 5;

  const hits: RecallHit[] = [];

  if (tier === "any" || tier === "short") {
    // Pull a broad candidate set, then score in JS. SQL LIKE per-term would be
    // OR-shaped and we want coverage; doing it in JS keeps the scoring honest.
    const notes = listNotes(db, {
      project_id: projectId,
      excludeExpired: true,
      limit: 500,
    });
    for (const n of notes) {
      const s = scoreNote(terms, n);
      if (s > 0) {
        hits.push({
          tier: "short",
          source: n.id,
          score: s,
          snippet: noteSnippet(n),
          createdAt: n.created_at,
        });
      }
    }
  }

  if (tier === "any" || tier === "long") {
    const facts = listFacts(db, { project_id: projectId, limit: 1000 });
    for (const f of facts) {
      const s = scoreFact(terms, f);
      if (s > 0) {
        hits.push({
          tier: "long",
          source: factLabel(f),
          score: s,
          snippet: factSnippet(f),
          createdAt: f.updated_at,
        });
      }
    }
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.createdAt.localeCompare(a.createdAt);
  });
  const top = hits.slice(0, limit);
  trackHits(db, top, opts);
  return top;
}

function trackHits(db: Database.Database, hits: RecallHit[], opts: RecallQueryOptions): void {
  if (!opts.trackRefs) return;
  for (const h of hits) {
    if (h.tier !== "short") continue;
    if (!h.source.startsWith("note_")) continue;
    recordNoteHit(db, h.source, {
      embedder: opts.autoPromote ? opts.embedder : undefined,
      threshold: opts.promoteThreshold,
    });
  }
}

/**
 * Async variant that adds semantic-search hits from memory_chunks into the
 * ranked union. Falls back gracefully when the embedder fails — keyword
 * results are always returned, even if semantic blows up.
 */
export async function recallQueryAsync(
  db: Database.Database,
  opts: RecallQueryOptions,
): Promise<RecallHit[]> {
  // recallQuery already tracks keyword note hits when trackRefs is set;
  // we don't want to double-track them at the merge stage.
  const keyword = recallQuery(db, opts);

  if (!opts.embedder || !opts.query.trim()) return keyword;
  // Tier filter applies to semantic too — chunks live in the long-term tier.
  if (opts.tier === "short") return keyword;

  let chunkHits: RecallHit[] = [];
  try {
    const embed = await opts.embedder.embed([opts.query], { model: opts.embedModel });
    const queryVec = embed.vectors[0];
    if (queryVec) {
      const semanticHits = semanticSearch(db, queryVec, {
        projectId: opts.projectId ?? null,
        limit: opts.limit ?? 5,
        minScore: opts.semanticMinScore ?? 0.3,
      });
      chunkHits = semanticHits.map((h) => ({
        tier: "long" as Tier,
        source: h.chunk.source,
        score: h.score,
        snippet: chunkSnippet(h.chunk.content),
        createdAt: h.chunk.created_at,
      }));
    }
  } catch (err) {
    console.error("[recall] semantic search failed:", (err as Error).message);
  }

  // Merge: dedupe by source — if a chunk's source matches a note id ("note:X"
  // vs "X"), prefer the higher score. Distinct sources just join.
  const bySource = new Map<string, RecallHit>();
  for (const h of [...keyword, ...chunkHits]) {
    const key = canonicalSourceKey(h);
    const existing = bySource.get(key);
    if (!existing || h.score > existing.score) bySource.set(key, h);
  }
  const merged = Array.from(bySource.values());
  merged.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.createdAt.localeCompare(a.createdAt);
  });
  return merged.slice(0, opts.limit ?? 5);
}

function chunkSnippet(content: string): string {
  const line = content.split("\n").find((l) => l.trim().length > 0) ?? content;
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

function canonicalSourceKey(h: RecallHit): string {
  // A note's keyword hit has source = "note_abc12345"; its chunk has
  // source = "note:note_abc12345". Normalize so they collapse.
  if (h.source.startsWith("note:")) return h.source.slice("note:".length);
  return h.source;
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
