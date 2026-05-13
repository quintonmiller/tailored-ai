import type Database from "better-sqlite3";
import { listFacts, type Fact } from "../db/fact-queries.js";
import { listNotes, type Note } from "../db/note-queries.js";

export type Tier = "short" | "long";

export interface RecallHit {
  tier: Tier;
  source: string;       // note id, or facts label "category:entity/key"
  score: number;        // 0..1
  snippet: string;      // short preview of the matching content
  createdAt: string;
}

export interface RecallQueryOptions {
  query: string;
  tier?: "any" | Tier;
  projectId?: string | null;
  limit?: number;
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
 * Returns hits ranked by score descending, ties broken by recency. M5 will
 * extend this to merge in semantic-similarity scores from memory_chunks.
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
  return hits.slice(0, limit);
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
