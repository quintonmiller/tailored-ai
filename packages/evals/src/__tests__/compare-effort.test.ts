/**
 * The comparison that catches work growing.
 *
 * #468 made a *request* that grew visible. A change that holds every pass rate
 * and adds a round to each turn, or doubles the tool calls, still costs real
 * time and real money and moved no number the diff printed. Same failure, one
 * step out.
 */

import { describe, expect, it, vi } from "vitest";
import { printComparison } from "../compare.js";
import type { BenchmarkReport } from "../types.js";

function report(over: { model?: string; rounds: number; calls: number; runs?: number }): BenchmarkReport {
  const runs = over.runs ?? 10;
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
      repeats: runs,
      seed: 1000,
      judge: false,
      scenarioSetHash: "hash",
      durationSeconds: 600,
      usage: { input: 1000 * runs, output: 100 * runs },
    },
    score: { overall: 1, passed: runs, total: runs, byCategory: {} },
    scenarios: [
      {
        id: "a",
        category: "c",
        intent: "i",
        passRate: 1,
        runs: Array.from({ length: runs }, () => ({
          pass: true,
          checks: [],
          outcome: {
            reply: "",
            posts: [],
            calls: Array.from({ length: over.calls }, (_, i) => ({ name: `t${i}`, args: {} })),
            requests: Array.from({ length: over.rounds }, () => ({
              system: "",
              messages: [],
              toolNames: [],
              estimatedTokens: 1000,
            })),
            usage: { input: 1000, output: 100 },
            latencyMs: 5000,
          },
        })),
      },
    ],
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

describe("a change that does more work without scoring differently", () => {
  it("reports extra rounds, even though every scenario still passes", () => {
    const out = capture(report({ rounds: 1, calls: 1 }), report({ rounds: 3, calls: 1 }));

    expect(out).toContain("work per run");
    expect(out).toMatch(/rounds 1\.0 → 3\.0 per run \(\+200%\)/);
    expect(out).toContain("no scenario moved beyond the noise floor");
  });

  it("reports extra tool calls", () => {
    const out = capture(report({ rounds: 2, calls: 1 }), report({ rounds: 2, calls: 4 }));

    expect(out).toMatch(/tool calls 1\.0 → 4\.0 per run/);
    // Rounds did not move, so they are not mentioned.
    expect(out).not.toMatch(/rounds .* → /);
  });

  it("reports work coming down as readily as going up", () => {
    const out = capture(report({ rounds: 4, calls: 2 }), report({ rounds: 1, calls: 2 }));

    expect(out).toMatch(/rounds 4\.0 → 1\.0 per run \(-75%\)/);
  });
});

describe("when a work move would mean nothing", () => {
  it("says nothing about a move inside the noise threshold", () => {
    const out = capture(report({ rounds: 20, calls: 10 }), report({ rounds: 21, calls: 10 }));

    expect(out).not.toContain("work per run");
  });

  it("ignores a move below half a call across the whole set", () => {
    // 0.02 → 0.04 tool calls per run is a 100% move and half a call in total.
    // A ratio alone would report it as a doubling.
    const before = report({ rounds: 1, calls: 0, runs: 100 });
    const after = report({ rounds: 1, calls: 0, runs: 100 });
    after.scenarios[0].runs[0].outcome.calls = [{ name: "t", args: {} }] as never;
    after.scenarios[0].runs[1].outcome.calls = [{ name: "t", args: {} }] as never;

    expect(capture(before, after)).not.toContain("work per run");
  });

  it("stays silent across different models", () => {
    // Two models take different numbers of rounds by construction. Reporting
    // that as a regression is comparing deployments and calling it a change.
    const out = capture(
      report({ model: "gpt-5.6", rounds: 1, calls: 1 }),
      report({ model: "deepseek-v4-pro", rounds: 5, calls: 5 }),
    );

    expect(out).not.toContain("work per run");
  });

  it("compares per run, so a differing repeat count does not read as a move", () => {
    const out = capture(report({ rounds: 2, calls: 1, runs: 10 }), report({ rounds: 2, calls: 1, runs: 30 }));

    expect(out).not.toContain("work per run");
  });

  it("does not divide by zero on a report with no runs", () => {
    const empty = report({ rounds: 0, calls: 0, runs: 0 });
    empty.scenarios = [];
    expect(() => capture(empty, report({ rounds: 2, calls: 1 }))).not.toThrow();
  });
});
