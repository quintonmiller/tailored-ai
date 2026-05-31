import type Database from "better-sqlite3";
import { listPinnedNotes, type Note } from "../db/note-queries.js";
import { type RecallHit, recallQuery } from "../tools/recall-query.js";

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
}

const DEFAULT_LIMIT = 5;
const DEFAULT_BUDGET = 800; // tokens
const DEFAULT_PINNED_BUDGET = 200; // tokens
const DEFAULT_PINNED_LIMIT = 4;

export interface MemoryInjectResult {
  block: string;
  /** Hits actually included in the rendered relevance block. */
  included: RecallHit[];
  /** Hits returned by recallQuery before the budget cap was applied. */
  total: number;
  /** Pinned notes included in the rendered pinned block. */
  pinned: PinnedHit[];
}

export interface PinnedHit {
  noteId: string;
  content: string;
}

/**
 * Build a `[Relevant memory]` block to prepend to the system prompt. Calls
 * `recallQuery` against the user's message and renders the top hits as a
 * short list, capped at `budgetTokens`. Returns an empty string when there
 * are no hits — callers can concatenate unconditionally.
 *
 * See docs/memory.md (M3) and DUX9 (pinned tier).
 */
export function buildMemoryBlock(db: Database.Database, opts: MemoryInjectOptions): string {
  return buildMemoryBlockWithMeta(db, opts).block;
}

/**
 * Two-tier memory injection (DUX9):
 *
 * 1. [Pinned preferences] — notes tagged `pinned` or with importance >= 0.95.
 *    Always inject regardless of relevance. Capped at `pinnedBudgetTokens`
 *    (default 200) and `pinnedLimit` (default 4).
 * 2. [Relevant memory] — relevance-ranked notes via recallQuery, deduped
 *    against the pinned set so a note can't appear twice. Uses the remaining
 *    portion of `budgetTokens`.
 *
 * Total budget is capped at `budgetTokens`. The pinned budget is clamped to
 * at most half of the total so a runaway "pin everything" can't crowd out
 * relevance-ranked context.
 */
export function buildMemoryBlockWithMeta(db: Database.Database, opts: MemoryInjectOptions): MemoryInjectResult {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const budget = opts.budgetTokens ?? DEFAULT_BUDGET;
  const pinnedBudget = Math.min(opts.pinnedBudgetTokens ?? DEFAULT_PINNED_BUDGET, Math.floor(budget / 2));
  const pinnedLimit = opts.pinnedLimit ?? DEFAULT_PINNED_LIMIT;

  // -------- Pinned tier --------
  const pinnedNotes = listPinnedNotes(db, {
    project_id: opts.projectId,
    limit: pinnedLimit * 2, // fetch some extra so budget trimming has options
  });
  const pinnedSection = renderPinned(pinnedNotes, pinnedBudget, pinnedLimit);

  // -------- Relevance tier --------
  const pinnedIds = new Set(pinnedSection.included.map((p) => p.noteId));
  const relevanceBudget = budget - pinnedSection.charsUsed / 4; // remaining tokens
  const hits = recallQuery(db, {
    query: opts.userMessage,
    projectId: opts.projectId,
    tier: "any",
    limit: limit + pinnedIds.size, // overfetch so dedupe doesn't shrink result
  });
  const relevant = hits.filter((h) => !pinnedIds.has(h.source));
  const relevanceSection = renderRelevance(relevant, relevanceBudget * 4);

  // -------- Compose --------
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
  notes: Note[],
  budgetTokens: number,
  limit: number,
): { lines: string[]; included: PinnedHit[]; charsUsed: number } {
  const lines: string[] = [];
  const included: PinnedHit[] = [];
  const charBudget = budgetTokens * 4;
  let used = 0;
  for (const n of notes) {
    if (included.length >= limit) break;
    const line = `- ${oneLine(n.content)}`;
    if (used + line.length > charBudget) {
      if (included.length === 0) {
        // Always include at least the top pinned note even if it slightly overruns.
        lines.push(line);
        included.push({ noteId: n.id, content: n.content });
        used += line.length;
      }
      break;
    }
    lines.push(line);
    included.push({ noteId: n.id, content: n.content });
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
  // Collapse internal newlines so each pinned preference renders on a single
  // line — these are short rules, not transcripts.
  return s.replace(/\s*\n+\s*/g, " · ").trim();
}
