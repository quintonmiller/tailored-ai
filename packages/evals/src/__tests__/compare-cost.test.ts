/**
 * The half of cost reporting that earns its keep.
 *
 * A prompt edit that doubles the request and leaves every pass rate alone is
 * currently invisible to `compare` — and that is precisely the failure this
 * benchmark exists to catch, the invocation message growing without anyone
 * deciding it should. Nobody asks about it until the bill arrives.
 */

import { describe, expect, it, vi } from "vitest";
import { printComparison } from "../compare.js";
import type { BenchmarkReport } from "../types.js";

function report(over: {
  model?: string;
  input: number;
  output: number;
  runs?: number;
  usd?: number;
  scenarioIds?: string[];
}): BenchmarkReport {
  const runs = over.runs ?? 10;
  const ids = over.scenarioIds ?? ["a"];
  return {
    meta: {
      startedAt: "2026-08-09T00:00:00.000Z",
      finishedAt: "2026-08-09T00:10:00.000Z",
      gitSha: "abc1234",
      gitDirty: false,
      model: over.model ?? "gpt-5.6",
      baseUrl: "http://x/v1",
      provider: "openai_compatible",
      plugins: [],
      repeats: runs / ids.length,
      seed: 1000,
      judge: false,
      scenarioSetHash: "hash",
      durationSeconds: 600,
      // Totals for the whole run; the comparison divides by runs itself.
      usage: { input: over.input, output: over.output },
      ...(over.usd !== undefined ? { cost: { usd: over.usd, rates: { input: 1, output: 1, asOf: "x" } } } : {}),
    },
    score: { overall: 1, passed: runs, total: runs, byCategory: {} },
    scenarios: ids.map((id) => ({
      id,
      category: "c",
      intent: "i",
      passRate: 1,
      runs: Array.from({ length: runs / ids.length }, () => ({ pass: true, checks: [], outcome: {} as never })),
    })),
  } as unknown as BenchmarkReport;
}

function capture(before: BenchmarkReport, after: BenchmarkReport): string {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args) => {
    lines.push(args.join(" "));
  });
  try {
    printComparison(before, after);
  } finally {
    spy.mockRestore();
  }
  return lines.join("\n");
}

describe("a change that costs more without scoring differently", () => {
  it("is reported, even though no scenario moved", () => {
    const out = capture(report({ input: 100_000, output: 10_000 }), report({ input: 200_000, output: 10_000 }));

    expect(out).toContain("request size");
    expect(out).toMatch(/input .*10,000 → 20,000 per run \(\+100%\)/);
    // The score really did not move, and the comparison still says so.
    expect(out).toContain("no scenario moved beyond the noise floor");
  });

  it("separates a bigger prompt from a chattier model", () => {
    const out = capture(report({ input: 100_000, output: 10_000 }), report({ input: 100_000, output: 30_000 }));

    expect(out).toMatch(/output .*1,000 → 3,000/);
    expect(out).not.toMatch(/input .*→/);
  });

  it("shows the money when both runs priced the same model", () => {
    const out = capture(
      report({ input: 100_000, output: 10_000, usd: 0.5 }),
      report({ input: 400_000, output: 10_000, usd: 2.0 }),
    );

    expect(out).toContain("$0.50 → $2.00");
  });
});

describe("when a token move would mean nothing", () => {
  it("says nothing about a move within sampling noise", () => {
    const out = capture(report({ input: 100_000, output: 10_000 }), report({ input: 103_000, output: 10_200 }));

    expect(out).not.toContain("request size");
  });

  /**
   * Two models produce different token counts by construction — different
   * tokenizers, different verbosity. Reporting that as a cost move would be
   * comparing deployments and calling it a code change.
   */
  it("stays silent across different models", () => {
    const out = capture(
      report({ model: "gpt-5.6", input: 100_000, output: 10_000 }),
      report({ model: "deepseek-v4-pro", input: 400_000, output: 10_000 }),
    );

    expect(out).not.toContain("request size");
  });

  it("compares per run, so a differing repeat count does not read as a cost move", () => {
    // Same size per run; the later report simply ran twice as many.
    const out = capture(
      report({ input: 100_000, output: 10_000, runs: 10 }),
      report({ input: 200_000, output: 20_000, runs: 20 }),
    );

    expect(out).not.toContain("request size");
  });

  it("does not divide by zero on a report with no runs", () => {
    const empty = report({ input: 0, output: 0, runs: 0, scenarioIds: [] });
    expect(() => capture(empty, report({ input: 100_000, output: 10_000 }))).not.toThrow();
  });
});
