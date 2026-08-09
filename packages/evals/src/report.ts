/**
 * Printing a run, and scoring it.
 *
 * The score is a mean pass *rate*, not a count of passing scenarios, because a
 * scenario that passes two runs in three is genuinely different from one that
 * passes three — and rounding that to "pass" is how a benchmark stops noticing
 * a model getting less reliable.
 */

import { formatUsd, noCostReason, totalUsage, usdOf } from "./cost.js";
import type { BenchmarkReport, ScenarioResult } from "./types.js";

const num = (n: number) => n.toLocaleString("en-US");

const GREEN = "[32m";
const RED = "[31m";
const YELLOW = "[33m";
const DIM = "[2m";
const RESET = "[0m";

function colour(text: string, code: string): string {
  return process.stdout.isTTY ? `${code}${text}${RESET}` : text;
}

export function score(scenarios: ScenarioResult[]): BenchmarkReport["score"] {
  const byCategory: Record<string, { passed: number; total: number; rate: number }> = {};
  let passed = 0;
  let total = 0;

  for (const scenario of scenarios) {
    const runsPassed = scenario.runs.filter((r) => r.pass).length;
    const runsTotal = scenario.runs.length;
    passed += runsPassed;
    total += runsTotal;
    const bucket = (byCategory[scenario.category] ??= { passed: 0, total: 0, rate: 0 });
    bucket.passed += runsPassed;
    bucket.total += runsTotal;
  }

  for (const bucket of Object.values(byCategory)) bucket.rate = bucket.total ? bucket.passed / bucket.total : 0;
  return { overall: total ? passed / total : 0, passed, total, byCategory };
}

/**
 * What the process should exit with, and why.
 *
 * Separate from `cmdRun` so it can be tested: `cli.ts` runs `main()` at import,
 * so importing it from a test runs the benchmark.
 *
 * A scenario that errored is not a low score — it is a measurement that did not
 * happen, and `score()` cannot express it (no runs means 0/0, which leaves the
 * denominator rather than lowering the rate). Exiting non-zero is what stops a
 * partial run being published as though it covered the set.
 */
export function verdict(report: BenchmarkReport, minScore: number | null): { code: number; message?: string } {
  if (minScore !== null && report.score.overall < minScore) {
    return {
      code: 1,
      message: `Score ${(report.score.overall * 100).toFixed(1)}% is below --min-score ${(minScore * 100).toFixed(1)}%.`,
    };
  }
  const errored = report.scenarios.filter((s) => s.error).length;
  if (errored) {
    return {
      code: 1,
      message: `${errored} scenario(s) failed to run. The report was written, but it does not cover the whole set.`,
    };
  }
  return { code: 0 };
}

function bar(rate: number, width = 20): string {
  const filled = Math.round(rate * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function rateColour(rate: number): string {
  if (rate >= 0.9) return GREEN;
  if (rate >= 0.6) return YELLOW;
  return RED;
}

export function printScenario(scenario: ScenarioResult): void {
  const passedRuns = scenario.runs.filter((r) => r.pass).length;
  const label = `${passedRuns}/${scenario.runs.length}`;
  const verdict =
    scenario.passRate === 1
      ? colour("PASS", GREEN)
      : scenario.passRate === 0
        ? colour("FAIL", RED)
        : colour("FLAKY", YELLOW);
  console.log(`${verdict} ${label.padEnd(5)} ${scenario.category.padEnd(16)} ${scenario.id}`);

  if (scenario.passRate === 1) return;
  console.log(colour(`      ${scenario.intent}`, DIM));

  // One line per distinct failure, with how often it happened — the same check
  // failing three times is one problem, not three.
  const seen = new Map<string, number>();
  for (const run of scenario.runs) {
    for (const check of run.checks) {
      if (check.pass) continue;
      const key = `${check.kind}: ${check.detail ?? ""}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  for (const [detail, count] of seen) {
    const times = scenario.runs.length > 1 ? colour(` (${count}×)`, DIM) : "";
    console.log(`      ${colour("×", RED)} ${detail}${times}`);
  }
}

export function printSummary(report: BenchmarkReport): void {
  const { score: s, meta } = report;
  console.log("");
  const via = meta.plugins?.length ? meta.plugins.join(", ") : meta.baseUrl;
  console.log(`  model      ${meta.model}   ${colour(`(${meta.provider ?? "openai_compatible"} — ${via})`, DIM)}`);
  console.log(`  code       ${meta.gitSha}${meta.gitDirty ? colour(" +uncommitted", YELLOW) : ""}`);
  console.log(
    `  scenarios  ${report.scenarios.length} × ${meta.repeats} run${meta.repeats === 1 ? "" : "s"}   ${colour(`set ${meta.scenarioSetHash}`, DIM)}`,
  );
  console.log(`  wall clock ${Math.round(meta.durationSeconds)}s`);

  // Split, never summed: input and output are priced an order of magnitude
  // apart, so one figure cannot tell a bigger prompt from a chattier model.
  const usage = totalUsage(report);
  const usd = usdOf(report);
  const cache = usage.cacheRead !== undefined ? `, ${num(usage.cacheRead)} cached` : "";
  const money = usd === null ? colour(`  (${noCostReason(meta.model)})`, DIM) : `  ${formatUsd(usd)}`;
  console.log(`  tokens     ${num(usage.input)} in${cache} · ${num(usage.output)} out${money}`);
  console.log("");

  const names = Object.keys(s.byCategory).sort();
  const width = Math.max(...names.map((n) => n.length), 8);
  for (const name of names) {
    const bucket = s.byCategory[name];
    const pct = `${Math.round(bucket.rate * 100)}%`.padStart(4);
    console.log(
      `  ${name.padEnd(width)}  ${colour(bar(bucket.rate), rateColour(bucket.rate))} ${pct}  ${colour(`${bucket.passed}/${bucket.total}`, DIM)}`,
    );
  }

  console.log("");
  const pct = (s.overall * 100).toFixed(1);
  console.log(
    `  ${"SCORE".padEnd(width)}  ${colour(bar(s.overall), rateColour(s.overall))} ${colour(`${pct}%`, rateColour(s.overall))}  ${colour(`${s.passed}/${s.total} runs`, DIM)}`,
  );

  // A scenario that errored has no runs, so it is 0/0 to `score()` — it does not
  // lower the percentage, it silently leaves the denominator. Saying so next to
  // the number is the difference between "the model scored 91%" and "the model
  // scored 91% of the two thirds of the set that ran".
  const errored = report.scenarios.filter((sc) => sc.error);
  if (errored.length) {
    console.log("");
    console.log(
      colour(
        `  ${errored.length} of ${report.scenarios.length} scenario(s) did not run, and are not in that score:`,
        RED,
      ),
    );
    for (const sc of errored) console.log(`      ${colour("×", RED)} ${sc.id}: ${sc.error}`);
  }
  console.log("");
}
