import type Database from "better-sqlite3";
import { recallQuery, type RecallHit } from "../tools/recall-query.js";

export interface MemoryInjectOptions {
  /** User message used as the search query. */
  userMessage: string;
  /** Project scope. null = global. */
  projectId: string | null;
  /** Hard cap on hits to consider. */
  limit?: number;
  /** Token budget for the rendered block (estimated at ~4 chars/token). */
  budgetTokens?: number;
}

const DEFAULT_LIMIT = 5;
const DEFAULT_BUDGET = 800; // tokens

/**
 * Build a `[Relevant memory]` block to prepend to the system prompt. Calls
 * `recallQuery` against the user's message and renders the top hits as a
 * short list, capped at `budgetTokens`. Returns an empty string when there
 * are no hits — callers can concatenate unconditionally.
 *
 * See docs/memory-tiers.md (M3).
 */
export function buildMemoryBlock(
  db: Database.Database,
  opts: MemoryInjectOptions,
): string {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const budget = opts.budgetTokens ?? DEFAULT_BUDGET;

  const hits = recallQuery(db, {
    query: opts.userMessage,
    projectId: opts.projectId,
    tier: "any",
    limit,
  });
  if (hits.length === 0) return "";

  const lines: string[] = ["", "[Relevant memory]"];
  const charBudget = budget * 4;
  let used = 0;
  let included = 0;
  for (const h of hits) {
    const line = formatLine(h);
    if (used + line.length > charBudget) {
      if (included === 0) {
        // Always include at least the top hit, even if it overruns slightly.
        lines.push(line);
        included++;
      }
      break;
    }
    lines.push(line);
    used += line.length;
    included++;
  }
  if (included < hits.length) {
    lines.push(`(${hits.length - included} more hidden)`);
  }
  lines.push("[/Relevant memory]");
  return `${lines.join("\n")}\n`;
}

function formatLine(h: RecallHit): string {
  return `- (${h.tier}) ${h.source}: ${h.snippet}`;
}
