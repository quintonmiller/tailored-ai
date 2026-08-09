/**
 * What a run exits with when part of it did not happen.
 *
 * `score()` is a rate over the runs that took place, so a scenario that errored
 * contributes 0 passed of 0 total: it does not lower the percentage, it quietly
 * leaves the denominator. A run where a third of the set failed to start can
 * therefore print a high score and exit 0, which is the same shape as the
 * harness once scoring 100% against a dead endpoint — machinery reporting a
 * success it had not earned.
 */

import { describe, expect, it } from "vitest";
import { score, verdict } from "../report.js";
import type { BenchmarkReport, ScenarioResult } from "../types.js";

function ran(id: string, category: string, passes: number, total: number): ScenarioResult {
  return {
    id,
    category,
    intent: `${id} intent`,
    runs: Array.from({ length: total }, (_, i) => ({ pass: i < passes, checks: [], outcome: {} as never })),
    passRate: total ? passes / total : 0,
  };
}

function errored(id: string, category: string, error: string): ScenarioResult {
  return { id, category, intent: `${id} intent`, runs: [], passRate: 0, error };
}

function reportOf(scenarios: ScenarioResult[]): BenchmarkReport {
  return { meta: {} as never, score: score(scenarios), scenarios };
}

describe("an errored scenario", () => {
  it("is not counted against the score, which is why the exit code has to carry it", () => {
    // Pinning the arithmetic that makes the exit code necessary: the two runs
    // that happened both passed, so the rate is 100% across a half-run set.
    const s = score([ran("a", "cat", 2, 2), errored("b", "cat", "worker produced no result (exit 1)")]);
    expect(s.overall).toBe(1);
    expect(s.total).toBe(2);
  });

  it("makes the run exit non-zero even at a perfect score", () => {
    const report = reportOf([ran("a", "cat", 2, 2), errored("b", "cat", "worker produced no result (exit 1)")]);
    expect(report.score.overall).toBe(1);
    const { code, message } = verdict(report, null);
    expect(code).toBe(1);
    expect(message).toContain("1 scenario(s) failed to run");
    expect(message).toContain("does not cover the whole set");
  });

  it("counts every scenario that did not run, not just the first", () => {
    const report = reportOf([ran("a", "cat", 1, 1), errored("b", "cat", "boom"), errored("c", "cat", "boom")]);
    expect(verdict(report, null).message).toContain("2 scenario(s)");
  });
});

describe("a run where everything ran", () => {
  it("exits zero, however badly it scored, with no --min-score", () => {
    const report = reportOf([ran("a", "cat", 0, 3), ran("b", "cat", 0, 3)]);
    expect(report.score.overall).toBe(0);
    expect(verdict(report, null)).toEqual({ code: 0 });
  });

  it("exits zero at exactly --min-score", () => {
    expect(verdict(reportOf([ran("a", "cat", 1, 2)]), 0.5).code).toBe(0);
  });

  it("exits non-zero below --min-score, saying both numbers", () => {
    const { code, message } = verdict(reportOf([ran("a", "cat", 1, 4)]), 0.5);
    expect(code).toBe(1);
    expect(message).toContain("25.0%");
    expect(message).toContain("50.0%");
  });
});

describe("when both are wrong at once", () => {
  it("reports the low score first, since that is the number the flag asked about", () => {
    const report = reportOf([ran("a", "cat", 0, 2), errored("b", "cat", "boom")]);
    const { code, message } = verdict(report, 0.9);
    expect(code).toBe(1);
    expect(message).toContain("below --min-score");
  });
});
