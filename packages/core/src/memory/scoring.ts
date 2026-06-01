/**
 * Keyword scoring helpers used by SqliteMemoryBackend.query to rank notes
 * and facts. Lives in `memory/` rather than `tools/recall-query.ts` so the
 * backend owns its ranking (per the design — see
 * docs/memory-storage-registry.md). The wrapper in `tools/recall-query.ts`
 * is now a thin adapter that converts MemoryFragment[] → RecallHit[].
 */

import type { Fact } from "../db/fact-queries.js";
import type { Note } from "../db/note-queries.js";

/**
 * Split a free-form query into matching terms. Lowercase, drop very short
 * tokens, dedupe. Kept as a small public helper for callers that want the
 * exact same tokenization the SQLite backend uses.
 */
export function tokenize(query: string): string[] {
  const raw = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/u)
    .filter((t) => t.length >= 2);
  return Array.from(new Set(raw));
}

/**
 * Coverage score in [0, 1]: how many unique query terms appear as
 * substrings inside the haystack. Bias-free baseline — callers add field
 * bonuses on top.
 */
export function coverage(terms: string[], haystack: string): number {
  if (terms.length === 0) return 0;
  const hay = haystack.toLowerCase();
  let hits = 0;
  for (const t of terms) if (hay.includes(t)) hits++;
  return hits / terms.length;
}

export function scoreNote(terms: string[], n: Note): number {
  const tagBlob = n.tags.join(" ");
  const base = coverage(terms, `${n.content} ${tagBlob}`);
  if (base === 0) return 0;
  const tagBonus = tagBlob.length > 0 && coverage(terms, tagBlob) > 0 ? 0.1 : 0;
  const importanceBoost = n.importance ? Math.min(n.importance, 1) * 0.1 : 0;
  return base + tagBonus + importanceBoost;
}

export function scoreFact(terms: string[], f: Fact): number {
  const haystack = `${f.category} ${f.entity} ${f.key} ${f.value}`;
  const base = coverage(terms, haystack);
  if (base === 0) return 0;
  const keyHit = coverage(terms, `${f.key} ${f.entity}`);
  const keyBonus = keyHit > 0 ? 0.15 : 0;
  return base + keyBonus;
}

export function noteSnippet(n: Note): string {
  const line = n.content.split("\n")[0] ?? "";
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

export function factLabel(f: Fact): string {
  return f.entity ? `${f.category}:${f.entity}/${f.key}` : `${f.category}/${f.key}`;
}

export function factSnippet(f: Fact): string {
  const v = f.value.length > 160 ? `${f.value.slice(0, 160)}…` : f.value;
  return `= ${v}`;
}

export function chunkSnippet(content: string): string {
  const line = content.split("\n").find((l) => l.trim().length > 0) ?? content;
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}
