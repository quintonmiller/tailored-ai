/**
 * Cost reporting, and the two ways it could lie.
 *
 * A wrong price is worse than a missing one — nobody re-checks a plausible
 * figure — so a model with no entry gets tokens and no money. And a cached read
 * that nobody reported must stay *absent* rather than becoming zero, because 0
 * cached tokens reads as "the cache is not working".
 */

import { describe, expect, it } from "vitest";
import { addUsage, costOf, formatUsd, type ModelPrice, priceFor, totalUsage, usageOfScenarios } from "../cost.js";
import type { BenchmarkReport, ScenarioResult } from "../types.js";

const TABLE: Record<string, ModelPrice> = {
  "gpt-5.6": { input: 1.25, output: 10, cachedInput: 0.125, asOf: "2026-08-09" },
  "deepseek-v4-pro": { input: 0.28, output: 0.42, cachedInput: 0.0036, asOf: "2026-08-09" },
  "no-cache-model": { input: 2, output: 4, asOf: "2026-08-09" },
};

function scenario(runs: Array<{ input: number; output: number; cacheRead?: number }>): ScenarioResult {
  return {
    id: "s",
    category: "c",
    intent: "i",
    passRate: 1,
    runs: runs.map((usage) => ({ pass: true, checks: [], outcome: { usage } as never })),
  };
}

describe("priceFor", () => {
  it("matches an exact model id", () => {
    expect(priceFor("gpt-5.6", TABLE)?.input).toBe(1.25);
  });

  it("matches the longest prefix, so a dated vendor id keeps its price", () => {
    expect(priceFor("gpt-5.6-2026-07-01", TABLE)?.input).toBe(1.25);
  });

  it("returns null for a model it does not know rather than guessing", () => {
    expect(priceFor("qwen3.6-27b-vllm", TABLE)).toBeNull();
  });
});

describe("costOf", () => {
  it("prices input and output at their own rates", () => {
    // 1M input at $1.25 + 1M output at $10.
    expect(costOf({ input: 1_000_000, output: 1_000_000 }, "gpt-5.6", TABLE)).toBeCloseTo(11.25, 6);
  });

  it("returns null for an unpriced model, so tokens show and money does not", () => {
    expect(costOf({ input: 1_000_000, output: 1_000 }, "qwen3.6-27b-vllm", TABLE)).toBeNull();
  });

  /**
   * Providers report `cached_tokens` as a *subset* of `prompt_tokens`. Adding
   * the cached charge on top of the full input charge bills the same tokens
   * twice — and gets the sign of the whole feature backwards, making a run that
   * cached well look more expensive than one that cached nothing.
   */
  it("bills a cached read instead of the uncached rate, not on top of it", () => {
    const usage = { input: 1_000_000, output: 0, cacheRead: 1_000_000 };

    const cost = costOf(usage, "gpt-5.6", TABLE);

    // All of it cached: 1M × $0.125, not 1M × $1.25 and not their sum.
    expect(cost).toBeCloseTo(0.125, 6);
  });

  it("caching makes a run cheaper, never dearer", () => {
    const uncached = costOf({ input: 1_000_000, output: 0 }, "gpt-5.6", TABLE) as number;
    const cached = costOf({ input: 1_000_000, output: 0, cacheRead: 800_000 }, "gpt-5.6", TABLE) as number;

    expect(cached).toBeLessThan(uncached);
  });

  it("ignores a cached count for a model with no cached rate", () => {
    const withCache = costOf({ input: 1_000_000, output: 0, cacheRead: 900_000 }, "no-cache-model", TABLE);
    const without = costOf({ input: 1_000_000, output: 0 }, "no-cache-model", TABLE);

    expect(withCache).toBe(without);
  });

  it("never lets a reported cache exceed the input it is a subset of", () => {
    // A provider reporting more cached than prompt tokens must not produce a
    // negative uncached charge.
    const cost = costOf({ input: 1000, output: 0, cacheRead: 99_999 }, "gpt-5.6", TABLE) as number;
    expect(cost).toBeGreaterThanOrEqual(0);
  });
});

describe("addUsage", () => {
  it("keeps cache absent when neither side reported it", () => {
    const total = addUsage({ input: 1, output: 2 }, { input: 3, output: 4 });
    expect(total).toEqual({ input: 4, output: 6 });
    expect("cacheRead" in total).toBe(false);
  });

  it("keeps cache present once any call reported it", () => {
    const total = addUsage({ input: 1, output: 2 }, { input: 3, output: 4, cacheRead: 5 });
    expect(total.cacheRead).toBe(5);
  });
});

describe("totalUsage", () => {
  it("prefers the recorded total", () => {
    const report = { meta: { usage: { input: 10, output: 20 } }, scenarios: [] } as unknown as BenchmarkReport;
    expect(totalUsage(report)).toEqual({ input: 10, output: 20 });
  });

  /**
   * The reason no baseline needs re-running: every report already held the
   * per-run numbers, only the total was missing.
   */
  it("falls back to summing the runs, so a report written before meta.usage still reads", () => {
    const report = {
      meta: {},
      scenarios: [
        scenario([
          { input: 100, output: 10 },
          { input: 200, output: 20 },
        ]),
      ],
    } as unknown as BenchmarkReport;

    expect(totalUsage(report)).toEqual({ input: 300, output: 30 });
  });

  it("survives a scenario that errored and has no runs", () => {
    const errored = { id: "e", category: "c", intent: "i", runs: [], passRate: 0, error: "boom" } as ScenarioResult;
    expect(usageOfScenarios([scenario([{ input: 5, output: 1 }]), errored])).toEqual({ input: 5, output: 1 });
  });
});

describe("formatUsd", () => {
  it("keeps enough digits to be actionable at benchmark scale", () => {
    expect(formatUsd(0.0041)).toBe("$0.0041");
    expect(formatUsd(12.3456)).toBe("$12.35");
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.00001)).toBe("<$0.0001");
  });
});
