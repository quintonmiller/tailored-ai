import type { MemoryBackend, MemoryFragment } from "../memory/interface.js";
import type { EmbeddingProvider } from "../providers/embedding.js";
import { type RecallHit, recallQueryAsync } from "../tools/recall-query.js";

export interface MemoryInjectOptions {
  /** User message used as the search query. */
  userMessage: string;
  /** Project scope. null = global. */
  projectId: string | null;
  /** Hard cap on relevance-ranked hits to consider. */
  limit?: number;
  /** Token budget for the rendered block (estimated at ~4 chars/token). */
  budgetTokens?: number;
  /** Token budget reserved for the pinned-preferences sub-block. */
  pinnedBudgetTokens?: number;
  /** Hard cap on number of pinned notes to render. */
  pinnedLimit?: number;
  /**
   * Embedder for the relevance tier — when set, the backend gets a query
   * vector to run semantic search alongside keyword recall.
   */
  embedder?: EmbeddingProvider;
}

const DEFAULT_LIMIT = 5;
const DEFAULT_BUDGET = 800; // tokens
const DEFAULT_PINNED_BUDGET = 200; // tokens
const DEFAULT_PINNED_LIMIT = 4;

export interface MemoryInjectResult {
  block: string;
  /** Hits actually included in the rendered relevance block. */
  included: RecallHit[];
  /** Hits returned by recall before the budget cap was applied. */
  total: number;
  /** Pinned notes included in the rendered pinned block. */
  pinned: PinnedHit[];
}

export interface PinnedHit {
  noteId: string;
  content: string;
}

/**
 * Build a `[Relevant memory]` block to prepend to the system prompt.
 * Returns an empty string when there are no hits — callers can concat
 * unconditionally. See docs/memory.md (M3) and DUX9 (pinned tier).
 */
export async function buildMemoryBlock(backend: MemoryBackend, opts: MemoryInjectOptions): Promise<string> {
  return (await buildMemoryBlockWithMeta(backend, opts)).block;
}

/**
 * Two-tier memory injection (DUX9):
 *
 * 1. [Pinned preferences] — notes the backend surfaces with
 *    `metadata.pinned: true`. Always inject regardless of relevance.
 *    SQLite uses pinned-tag + importance >= 0.95; plugin backends may
 *    skip this tier entirely (no `metadata.pinned`, no pinned block).
 *    Capped at `pinnedBudgetTokens` (default 200) and `pinnedLimit`
 *    (default 4).
 * 2. [Relevant memory] — relevance-ranked items, deduped against the
 *    pinned set. Uses the remaining portion of `budgetTokens`.
 *
 * Total budget is capped at `budgetTokens`. The pinned budget is
 * clamped to at most half of the total so "pin everything" can't crowd
 * out relevance-ranked context.
 */
export async function buildMemoryBlockWithMeta(
  backend: MemoryBackend,
  opts: MemoryInjectOptions,
): Promise<MemoryInjectResult> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const budget = opts.budgetTokens ?? DEFAULT_BUDGET;
  const pinnedBudget = Math.min(opts.pinnedBudgetTokens ?? DEFAULT_PINNED_BUDGET, Math.floor(budget / 2));
  const pinnedLimit = opts.pinnedLimit ?? DEFAULT_PINNED_LIMIT;

  // Pinned tier — separate call so we get the full pinned set
  // regardless of relevance to the user message. `freeText` left empty
  // so the backend returns prelude items only.
  const pinnedFragments = await backend.query({
    includePrelude: true,
    scope: opts.projectId ? `project:${opts.projectId}` : "global",
    limit: pinnedLimit * 2,
  });
  const pinnedOnly = pinnedFragments.filter((f) => f.metadata?.pinned === true);
  const pinnedSection = renderPinned(pinnedOnly, pinnedBudget, pinnedLimit);

  // Relevance tier — drives off the user message.
  const pinnedIds = new Set(pinnedSection.included.map((p) => p.noteId));
  const relevanceBudget = budget - pinnedSection.charsUsed / 4;
  const hits = await recallQueryAsync(backend, {
    query: opts.userMessage,
    projectId: opts.projectId,
    tier: "any",
    limit: limit + pinnedIds.size,
    embedder: opts.embedder,
  });
  const relevant = hits.filter((h) => !pinnedIds.has(h.source));
  const relevanceSection = renderRelevance(relevant, relevanceBudget * 4);

  if (pinnedSection.lines.length === 0 && relevanceSection.lines.length === 0) {
    return { block: "", included: [], total: hits.length, pinned: [] };
  }

  const parts: string[] = [];
  if (pinnedSection.lines.length > 0) {
    parts.push("", "[Pinned preferences]", ...pinnedSection.lines, "[/Pinned preferences]");
  }
  if (relevanceSection.lines.length > 0) {
    parts.push("", "[Relevant memory]", ...relevanceSection.lines, "[/Relevant memory]");
  }
  return {
    block: `${parts.join("\n")}\n`,
    included: relevanceSection.included,
    total: hits.length,
    pinned: pinnedSection.included,
  };
}

function renderPinned(
  fragments: MemoryFragment[],
  budgetTokens: number,
  limit: number,
): { lines: string[]; included: PinnedHit[]; charsUsed: number } {
  const lines: string[] = [];
  const included: PinnedHit[] = [];
  const charBudget = budgetTokens * 4;
  let used = 0;
  for (const f of fragments) {
    if (included.length >= limit) break;
    const noteId = stripNotePrefix(f.id ?? "");
    const line = `- ${oneLine(f.text)}`;
    if (used + line.length > charBudget) {
      if (included.length === 0) {
        // Always include at least the top pinned item even if it slightly overruns.
        lines.push(line);
        included.push({ noteId, content: f.text });
        used += line.length;
      }
      break;
    }
    lines.push(line);
    included.push({ noteId, content: f.text });
    used += line.length;
  }
  return { lines, included, charsUsed: used };
}

function renderRelevance(hits: RecallHit[], charBudget: number): { lines: string[]; included: RecallHit[] } {
  const lines: string[] = [];
  const included: RecallHit[] = [];
  if (hits.length === 0) return { lines, included };
  let used = 0;
  for (const h of hits) {
    const line = `- (${h.tier}) ${h.source}: ${h.snippet}`;
    if (used + line.length > charBudget) {
      if (included.length === 0) {
        lines.push(line);
        included.push(h);
      }
      break;
    }
    lines.push(line);
    included.push(h);
    used += line.length;
  }
  if (included.length < hits.length) {
    lines.push(`(${hits.length - included.length} more hidden)`);
  }
  return { lines, included };
}

function oneLine(s: string): string {
  return s.replace(/\s*\n+\s*/g, " · ").trim();
}

function stripNotePrefix(id: string): string {
  return id.startsWith("note:") ? id.slice("note:".length) : id;
}
