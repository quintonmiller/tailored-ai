/**
 * Diffing two runs — the reason the benchmark exists.
 *
 * A single score answers "how good is it"; a comparison answers "did my change
 * break something", which is the question anyone actually has. Two guards keep
 * it from lying:
 *
 *   Different scenario sets are refused outright. Comparing 40 scenarios against
 *   a later 48 shows a score move that is entirely an artefact of the extra
 *   eight, and nothing about the change.
 *
 *   Small moves are labelled as noise rather than reported as findings. At three
 *   repeats one flipped run is 33 points, and treating that as a regression
 *   means chasing sampling every time.
 */

import type { BenchmarkReport } from "./types.js";

export interface ComparisonRow {
  id: string;
  category: string;
  before: number;
  after: number;
  delta: number;
  verdict: "regressed" | "improved" | "noise" | "same";
}

/**
 * How big a move has to be before it is worth reading.
 *
 * One flipped run out of `repeats` is the smallest change the sample can
 * express, so anything at or below it is indistinguishable from resampling.
 * The threshold is "more than one run", which at 1 repeat means nothing is
 * ever noise — correct, because a 1-repeat run cannot separate the two.
 */
function significant(delta: number, repeats: number): boolean {
  if (repeats <= 1) return delta !== 0;
  return Math.abs(delta) > 1 / repeats + 1e-9;
}

/**
 * A report written before a provider was recorded, or by the built-in client,
 * leaves `provider` unset — that is the generic OpenAI-compatible path
 * (`harness.ts`), not a missing value, so the warning should say which client
 * it means rather than printing "undefined" at the reader.
 */
function providerLabel(report: BenchmarkReport): string {
  return report.meta.provider ?? "openai_compatible";
}

export function compareReports(
  before: BenchmarkReport,
  after: BenchmarkReport,
): { rows: ComparisonRow[]; added: string[]; removed: string[]; warnings: string[] } {
  const warnings: string[] = [];
  if (before.meta.scenarioSetHash !== after.meta.scenarioSetHash) {
    warnings.push(
      `scenario sets differ (${before.meta.scenarioSetHash} → ${after.meta.scenarioSetHash}) — ` +
        "per-scenario rows are still valid, the overall score is not comparable",
    );
  }
  if (before.meta.model !== after.meta.model) {
    warnings.push(`different models (${before.meta.model} → ${after.meta.model}) — this compares models, not code`);
  }
  if ((before.meta.provider ?? "") !== (after.meta.provider ?? "")) {
    warnings.push(
      `different providers (${providerLabel(before)} → ${providerLabel(after)}) — a plugin and the generic client ` +
        "build different requests, so this compares clients too",
    );
  }
  if (before.meta.repeats !== after.meta.repeats) {
    warnings.push(`different repeat counts (${before.meta.repeats} → ${after.meta.repeats}) — noise floors differ`);
  }

  const beforeById = new Map(before.scenarios.map((s) => [s.id, s]));
  const afterById = new Map(after.scenarios.map((s) => [s.id, s]));
  const repeats = Math.min(before.meta.repeats, after.meta.repeats);

  const rows: ComparisonRow[] = [];
  for (const [id, a] of afterById) {
    const b = beforeById.get(id);
    if (!b) continue;
    const delta = a.passRate - b.passRate;
    const verdict: ComparisonRow["verdict"] =
      delta === 0 ? "same" : !significant(delta, repeats) ? "noise" : delta < 0 ? "regressed" : "improved";
    rows.push({ id, category: a.category, before: b.passRate, after: a.passRate, delta, verdict });
  }

  rows.sort((x, y) => x.delta - y.delta);
  return {
    rows,
    added: [...afterById.keys()].filter((id) => !beforeById.has(id)),
    removed: [...beforeById.keys()].filter((id) => !afterById.has(id)),
    warnings,
  };
}

export function printComparison(before: BenchmarkReport, after: BenchmarkReport): boolean {
  const { rows, added, removed, warnings } = compareReports(before, after);
  const pct = (n: number) => `${Math.round(n * 100)}%`.padStart(4);

  console.log("");
  console.log(`  before  ${before.meta.gitSha}  ${before.meta.model}  ${pct(before.score.overall)}`);
  console.log(`  after   ${after.meta.gitSha}  ${after.meta.model}  ${pct(after.score.overall)}`);
  console.log("");
  for (const warning of warnings) console.log(`  ! ${warning}`);
  if (warnings.length) console.log("");

  const regressed = rows.filter((r) => r.verdict === "regressed");
  const improved = rows.filter((r) => r.verdict === "improved");
  const noise = rows.filter((r) => r.verdict === "noise");

  for (const [title, group] of [
    ["regressed", regressed],
    ["improved", improved],
  ] as const) {
    if (!group.length) continue;
    console.log(`  ${title}:`);
    for (const row of group) {
      const sign = row.delta > 0 ? "+" : "";
      console.log(`    ${pct(row.before)} → ${pct(row.after)}  (${sign}${Math.round(row.delta * 100)})  ${row.id}`);
    }
    console.log("");
  }

  if (noise.length) console.log(`  ${noise.length} scenario(s) moved by one run — within noise at this repeat count.`);
  if (added.length) console.log(`  ${added.length} new scenario(s): ${added.join(", ")}`);
  if (removed.length) console.log(`  ${removed.length} removed scenario(s): ${removed.join(", ")}`);
  if (!regressed.length && !improved.length) console.log("  no scenario moved beyond the noise floor.");
  console.log("");

  return regressed.length > 0;
}
