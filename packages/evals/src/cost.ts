/**
 * What a run cost — tokens, and money where we know the price.
 *
 * The benchmark exists to catch the invocation message growing without anyone
 * deciding it should. A score alone cannot see that: a change that doubles the
 * request and leaves the pass rate alone is invisible, and the bill is where it
 * eventually shows up.
 *
 * Two rules the rest of this file follows:
 *
 *   **Input and output stay separate.** They are priced an order of magnitude
 *   apart, and one combined figure cannot tell *the prompt got bigger* from
 *   *the model talked more*. Those have opposite fixes.
 *
 *   **A model with no price shows tokens and no money.** Guessing at a rate
 *   would put a number on a page that reads as measured, and a wrong cost is
 *   worse than an absent one — nobody checks a plausible figure.
 */

import type { BenchmarkReport, RunUsage, ScenarioResult } from "./types.js";

/** USD per million tokens. `cachedInput` only where the provider reports cache hits. */
export interface ModelPrice {
  input: number;
  output: number;
  cachedInput?: number;
  /** Shown next to the money, so a stale table is visible rather than trusted. */
  asOf: string;
}

/**
 * Prices are a fact about the world on a date, not about this code, so each
 * carries the date it was taken. They are matched by exact model id first, then
 * by the longest prefix — hosted vendors version their ids (`gpt-5.6-2026-07-01`)
 * and a run should not lose its cost to a dated suffix.
 *
 * Locally-served models have no per-token price. They are deliberately absent
 * rather than priced at 0: zero would render as "free", and the GPU-hours are
 * real even when no invoice names them.
 */
export const PRICES: Record<string, ModelPrice> = {
  "gpt-5.6": { input: 1.25, output: 10.0, cachedInput: 0.125, asOf: "2026-08-09" },
  "claude-opus-5": { input: 5.0, output: 25.0, cachedInput: 0.5, asOf: "2026-08-09" },
  "claude-sonnet-5": { input: 3.0, output: 15.0, cachedInput: 0.3, asOf: "2026-08-09" },
  "deepseek-v4-pro": { input: 0.28, output: 0.42, cachedInput: 0.0036, asOf: "2026-08-09" },
  "deepseek-v4-flash": { input: 0.07, output: 0.28, cachedInput: 0.0036, asOf: "2026-08-09" },
};

/** The price for a model id, or `null` when we do not know one. Never a guess. */
export function priceFor(model: string, table: Record<string, ModelPrice> = PRICES): ModelPrice | null {
  if (table[model]) return table[model];
  const prefixes = Object.keys(table)
    .filter((id) => model.startsWith(id))
    .sort((a, b) => b.length - a.length);
  return prefixes.length ? table[prefixes[0]] : null;
}

export function addUsage(into: RunUsage, add: RunUsage | undefined): RunUsage {
  if (!add) return into;
  const out: RunUsage = { input: into.input + add.input, output: into.output + add.output };
  // Only carry the cache fields if some call actually reported them, so
  // "absent" survives aggregation instead of collapsing to zero.
  const cacheRead = (into.cacheRead ?? 0) + (add.cacheRead ?? 0);
  const cacheWrite = (into.cacheWrite ?? 0) + (add.cacheWrite ?? 0);
  if (into.cacheRead !== undefined || add.cacheRead !== undefined) out.cacheRead = cacheRead;
  if (into.cacheWrite !== undefined || add.cacheWrite !== undefined) out.cacheWrite = cacheWrite;
  return out;
}

/**
 * Total a report's usage.
 *
 * Prefers `meta.usage`, and falls back to summing the runs — which is what
 * makes every report written before this existed readable without re-running
 * anything. The data was always there; only the total was missing.
 */
export function totalUsage(report: Pick<BenchmarkReport, "meta" | "scenarios">): RunUsage {
  if (report.meta?.usage) return report.meta.usage;
  return usageOfScenarios(report.scenarios ?? []);
}

export function usageOfScenarios(scenarios: ScenarioResult[]): RunUsage {
  let total: RunUsage = { input: 0, output: 0 };
  for (const scenario of scenarios) {
    for (const run of scenario.runs ?? []) total = addUsage(total, run.outcome?.usage);
  }
  return total;
}

/**
 * USD for a usage total, or `null` when the model has no known price.
 *
 * Cached reads are billed at `cachedInput` and subtracted from the uncached
 * input rather than added on top — providers report `cached_tokens` as a
 * *subset* of `prompt_tokens`, so charging both double-counts the request.
 */
export function costOf(usage: RunUsage, model: string, table: Record<string, ModelPrice> = PRICES): number | null {
  const price = priceFor(model, table);
  if (!price) return null;

  const cached = price.cachedInput !== undefined ? Math.min(usage.cacheRead ?? 0, usage.input) : 0;
  const uncached = usage.input - cached;

  return (
    (uncached * price.input + cached * (price.cachedInput ?? price.input) + usage.output * price.output) / 1_000_000
  );
}

/**
 * What a run cost, and the rates that produced it — recorded into the report.
 *
 * The money is computed once, when the run happens, and stored. Two reasons:
 * every other consumer (the site, a future dashboard) then *displays* rather
 * than re-deriving, so two surfaces cannot disagree about a bill; and a price
 * is a fact about the world on a date, so a report that records its own rates
 * stays auditable after the table moves. That is the same principle as
 * recording `gitSha` and `seed` rather than looking them up later.
 *
 * `null` when the model has no known price — which stays null forever, even if
 * a price is added later. Backfilling would put today's rates on last month's
 * run and call it measurement.
 */
export function costRecord(usage: RunUsage, model: string, table = PRICES): CostRecord | null {
  const price = priceFor(model, table);
  const usd = costOf(usage, model, table);
  if (!price || usd === null) return null;
  return { usd, rates: price };
}

export interface CostRecord {
  usd: number;
  /** The per-million rates this was billed at, and when they were taken. */
  rates: ModelPrice;
}

/**
 * The money a report recorded, or `null`.
 *
 * Deliberately does *not* fall back to pricing an old report with today's
 * table. Tokens backfill safely because they are a fact the run measured;
 * money does not, because the rate is a fact about a date. A run from before
 * cost was recorded shows its tokens and no dollars, which is the honest
 * answer — unlike a plausible figure nobody would think to re-check.
 */
export function usdOf(report: Pick<BenchmarkReport, "meta">): number | null {
  return report.meta?.cost?.usd ?? null;
}

/** Why there is no money to show: an unpriced model, or a report predating the field. */
export function noCostReason(model: string, table = PRICES): string {
  return priceFor(model, table) ? "cost not recorded" : "no price for this model";
}

/** `$1.23`, `$0.0041`, `<$0.0001` — enough digits to be actionable at benchmark scale. */
export function formatUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.0001) return "<$0.0001";
  if (usd < 1) return `$${usd.toPrecision(2)}`;
  return `$${usd.toFixed(2)}`;
}
