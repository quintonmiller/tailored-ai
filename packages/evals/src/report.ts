/**
 * Printing a run, and scoring it.
 *
 * The score is a mean pass *rate*, not a count of passing scenarios, because a
 * scenario that passes two runs in three is genuinely different from one that
 * passes three — and rounding that to "pass" is how a benchmark stops noticing
 * a model getting less reliable.
 */

import { isStallStop } from "@tailored-ai/core";
import { formatUsd, noCostReason, totalUsage, usdOf } from "./cost.js";
import { describeDifficulty } from "./difficulty.js";
import { EFFORT_LABELS, formatMs, summariseScenarios } from "./efficiency.js";
import { milestoneScore } from "./graders.js";
import { FACT_STAGES } from "./routing.js";
import { simulationPolicies } from "./sim/index.js";
import { summariseResponses, traceResponses } from "./sim/latency.js";
import { runPolicy } from "./sim/sweep.js";
import { simulationReport } from "./sim/types.js";
import type { BenchmarkReport, FactTrace, MilestoneResult, ScenarioResult } from "./types.js";

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
  const byDifficulty: Record<string, { passed: number; total: number; rate: number }> = {};
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
    // Skipped rather than bucketed under "unknown": a scenario with no level is
    // one this build could not have loaded, so the only way to see one here is
    // re-scoring an old report. Inventing a bucket for it would put runs from a
    // different scale next to the current one.
    if (scenario.difficulty !== undefined) {
      const level = (byDifficulty[String(scenario.difficulty)] ??= { passed: 0, total: 0, rate: 0 });
      level.passed += runsPassed;
      level.total += runsTotal;
    }
  }

  for (const bucket of [...Object.values(byCategory), ...Object.values(byDifficulty)]) {
    bucket.rate = bucket.total ? bucket.passed / bucket.total : 0;
  }
  return {
    overall: total ? passed / total : 0,
    passed,
    total,
    byCategory,
    ...(Object.keys(byDifficulty).length ? { byDifficulty } : {}),
  };
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

/**
 * How far the run got, step by step.
 *
 * The output a long scenario exists to produce. "FAIL" for a team that decoded
 * the language, restored power and never installed the part is the same word as
 * "FAIL" for a team that sat still, and no amount of re-running tells them
 * apart — which is how a hard benchmark stops being usable as a development
 * instrument and becomes a number people quote.
 *
 * Averaged across repeats rather than shown per run: with three runs the
 * question is which steps are *reliable*, and a step reached once in three is a
 * different finding from one reached every time.
 */
export function printMilestones(scenario: ScenarioResult): void {
  const withLadders = scenario.runs.filter((r) => r.milestones?.length);
  if (!withLadders.length) return;

  const runs = withLadders.length;
  const order = withLadders[0].milestones as MilestoneResult[];
  const hits = new Map<string, number>();
  for (const run of withLadders) {
    for (const m of run.milestones ?? []) if (m.reached) hits.set(m.id, (hits.get(m.id) ?? 0) + 1);
  }

  const mean = withLadders.reduce((sum, r) => sum + milestoneScore(r.milestones ?? []).fraction, 0) / runs;
  const possible = milestoneScore(order).possible;
  console.log(
    `      ${colour("progress", DIM)}  ${colour(bar(mean, 12), rateColour(mean))} ${(mean * 100).toFixed(0)}% of ${possible} points`,
  );

  for (const milestone of order) {
    const hit = hits.get(milestone.id) ?? 0;
    const mark = hit === runs ? colour("✓", GREEN) : hit === 0 ? colour("×", RED) : colour("~", YELLOW);
    const rate = runs > 1 ? colour(` ${hit}/${runs}`, DIM) : "";
    // The reason only for a step nobody reached: a step reached twice in three
    // has no single reason, and printing one run's would read as the finding.
    const why =
      hit === 0 ? colour(`  ${withLadders[0].milestones?.find((m) => m.id === milestone.id)?.detail ?? ""}`, DIM) : "";
    console.log(
      `      ${mark} ${milestone.id.padEnd(28)}${colour(String(milestone.points).padStart(3), DIM)}${rate}${why}`,
    );
  }
}

/**
 * Where each fact got to, on the run that got it furthest.
 *
 * The best run rather than the mean, because this is a diagnosis and the
 * question it answers is "is this reachable at all". A fact that made it to
 * `used` once is a routing problem; a fact that never left the agent that found
 * it in any run is a different one.
 */
export function printFactRouting(scenario: ScenarioResult): void {
  const withFacts = scenario.runs.filter((r) => r.facts?.length);
  if (!withFacts.length) return;

  const depth = (t: FactTrace) => FACT_STAGES.filter((s) => t[s] !== undefined).length;
  const best = new Map<string, FactTrace>();
  for (const run of withFacts) {
    for (const trace of run.facts ?? []) {
      const seen = best.get(trace.name);
      if (!seen || depth(trace) > depth(seen)) best.set(trace.name, trace);
    }
  }

  console.log(`      ${colour("routing", DIM)}   ${colour("(furthest of any run)", DIM)}`);
  for (const trace of best.values()) {
    const marks = FACT_STAGES.map((stage) => {
      const at = trace[stage];
      return at ? colour(`${stage[0]}${at.agent}@${at.turn}`, GREEN) : colour(`${stage[0]}—`, RED);
    }).join(" ");
    console.log(`      ${trace.name.padEnd(24)} ${marks}`);
  }
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

  if (scenario.passRate === 1) {
    // A row can pass and still have missed steps: the assertions are the win
    // condition, the ladder is the whole picture, and they are not the same
    // question. `the-machine` passed its first live run with a milestone
    // unreached, and because a passing row printed nothing the miss was only
    // visible by reading the report JSON — where it turned out to be a defect in
    // the milestone rather than in the run.
    if (scenario.runs.some((r) => r.milestones?.some((m) => !m.reached))) printMilestones(scenario);
    printSimulation(scenario);
    return;
  }
  // The level rides along with the intent rather than the headline, because it
  // only changes how you read a *failure*: a red level-2 row is a defect, a red
  // level-5 row is the scenario doing its job.
  const level = scenario.difficulty === undefined ? "" : `[${describeDifficulty(scenario.difficulty)}] `;
  console.log(colour(`      ${level}${scenario.intent}`, DIM));

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

  // After the failures, because they say *what* went wrong and these say *how
  // far it got* — which is only worth reading once you know it went wrong.
  printMilestones(scenario);
  printFactRouting(scenario);
  printSimulation(scenario);
}

/**
 * Where the company ended up, and how long it took to notice things.
 *
 * Printed whether the row passed or failed, unlike everything else here, because
 * a simulation row has no interesting pass/fail: the assertions are a floor and
 * the *number* is the result. A green row that says nothing else would be the
 * least informative possible rendering of the most informative scenario.
 */
function printSimulation(scenario: ScenarioResult): void {
  const runs = scenario.runs.filter((r) => r.outcome.simulation);
  if (!runs.length) return;

  for (const [index, run] of runs.entries()) {
    const sim = run.outcome.simulation as NonNullable<typeof run.outcome.simulation>;
    const label = runs.length > 1 ? `run ${index + 1}: ` : "";
    // Read through the simulation's own declared report rather than the
    // factory's vocabulary. Hardcoding `enterpriseValue` here did the same
    // damage it did in `sweep.ts`: for a descent it is undefined, so every
    // baseline in the ladder below scored zero and the run was announced as
    // "ahead of every baseline" while sitting squarely mid-table.
    const report = simulationReport(sim.name);
    const show = report.format ?? ((n: number) => Math.round(n).toLocaleString("en-US"));
    const value = sim.metrics[report.key] ?? sim.objective;
    const created = sim.metrics.valueCreated;
    const managed = sim.daysManaged < sim.days ? colour(` — managed ${sim.daysManaged} of ${sim.days} days`, DIM) : "";
    const extra = (report.columns ?? [])
      .map((c) => {
        const raw = sim.metrics[c.key] ?? 0;
        return `  ${c.label} ${c.kind === "rate" ? (raw ? "yes" : "no") : show(raw)}`;
      })
      .join("");
    console.log(
      `      ${label}${show(value)} ${report.key}` +
        (created === undefined ? "" : ` (${created >= 0 ? "+" : ""}${money(created)})`) +
        extra +
        (sim.metrics.bankrupt ? colour("  BANKRUPT", RED) : "") +
        managed,
    );

    // Where it sits on the ladder, which is the only thing that makes the figure
    // above mean anything. Re-run here rather than stored: it costs milliseconds
    // and no model, and a number remembered from another build of the economy
    // would be worse than none.
    //
    // `sim.options` matters as much as the seed: a descent that started the
    // party on floor 30 compared against bots that started on floor 1 is not a
    // comparison, it is two different games with one number each.
    const ladder = Object.entries(simulationPolicies(sim.name))
      .map(([name, make]) => ({
        name,
        value:
          runPolicy(sim.name, make(), sim.seed, sim.days, sim.daysPerRound ?? 1, sim.options ?? {})[report.key] ?? 0,
      }))
      .sort((a, b) => a.value - b.value);
    const beaten = ladder.filter((b) => value > b.value).map((b) => b.name);
    const above = ladder.find((b) => b.value >= value);
    console.log(
      colour(
        `      ${beaten.length ? `beat ${beaten.join(", ")}` : "beat no baseline"}` +
          `${above ? `; behind ${above.name} at ${show(above.value)}` : "; ahead of every baseline"} (same seed)`,
        DIM,
      ),
    );

    const rows = traceResponses({
      events: sim.events,
      responses: sim.responses ?? {},
      executions: run.outcome.executions ?? [],
      dayOfTurn: sim.dayOfTurn,
      roles: sim.roles,
    });
    if (rows.length) {
      const summary = summariseResponses(rows);
      console.log(
        colour(
          `      reacted to ${summary.answered}/${summary.events} events` +
            `${summary.meanDays === null ? "" : `, ${summary.meanDays}d on average, worst ${summary.worstDays}d`}` +
            `; ${summary.crossRole} routed to another function`,
          DIM,
        ),
      );
      for (const row of rows.filter((r) => r.latencyDays === null)) {
        console.log(colour(`      ${colour("×", RED)} ${row.kind} on day ${row.day} was never acted on`, DIM));
      }
    }
  }
}

function money(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n)}`;
}

/**
 * Runs that ended because the agent got stuck, and runs that never said.
 *
 * A stall and a wrong answer score the same and mean opposite things — one is
 * the model not knowing, the other is the loop giving up — and the report could
 * not tell them apart, so every stalled run was read as a capability gap. That
 * is the whole reason the structured stop exists; not printing it wastes it.
 *
 * `unrecorded` is the regression signal. It was 56% of runs when the room path
 * reported nothing, and should now be zero: anything above it means a path
 * ended a turn without saying how.
 */
function stallsOf(report: BenchmarkReport): {
  stalled: Array<{ id: string; kind: string }>;
  unrecorded: number;
  runs: number;
} {
  const stalled: Array<{ id: string; kind: string }> = [];
  let unrecorded = 0;
  let runs = 0;
  for (const scenario of report.scenarios) {
    for (const run of scenario.runs) {
      runs++;
      const stop = run.outcome?.stop;
      // A run that threw never reached a loop, so it has nothing to report and
      // is not evidence of a path that stays quiet.
      if (!stop) {
        if (!run.outcome?.error) unrecorded++;
        continue;
      }
      if (isStallStop(stop)) stalled.push({ id: scenario.id, kind: stop.kind });
    }
  }
  return { stalled, unrecorded, runs };
}

/**
 * How many runs got stuck, and where.
 *
 * Printed by `regrade` as well as by a live run, because "were those failures
 * stalls or wrong answers?" is a question about a report you already have, and
 * answering it should not cost a model. Silent when there is nothing to say, so
 * a clean run stays clean.
 */
export function printStalls(report: BenchmarkReport): void {
  const { stalled, unrecorded, runs } = stallsOf(report);
  if (stalled.length) {
    // Named, because "3 runs stalled" sends you looking and "3 runs stalled, in
    // these scenarios" is the answer. Capped, then counted: a run where half the
    // set gets stuck should not push the score off the screen.
    const shown = [...new Set(stalled.map((s) => `${s.id} (${s.kind})`))];
    const rest = shown.length > 3 ? `, +${shown.length - 3} more` : "";
    console.log(
      `  ${colour("stalled", YELLOW)}    ${stalled.length} of ${runs} runs   ${colour(`${shown.slice(0, 3).join(", ")}${rest}`, DIM)}`,
    );
  }
  if (unrecorded) {
    console.log(
      `  ${colour("no stop", YELLOW)}    ${unrecorded} of ${runs} runs did not report why the turn ended   ${colour("(a stall there is invisible)", DIM)}`,
    );
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

  // The other axis. The score says whether the model was right; this says what
  // being right cost, and it keeps moving after the score stops. Median plus
  // max rather than a mean: the gap between them is the tail, and the tail is
  // where a turn that went round eleven times lives.
  const effort = summariseScenarios(report.scenarios);
  if (effort.runs) {
    const pair = (key: "rounds" | "toolCalls" | "latencyMs") => {
      const { label } = EFFORT_LABELS[key];
      // Counts render as integers here, unlike in `compare`, because a median
      // is a run that actually happened — "1.0 rounds" describes nothing.
      const render = key === "latencyMs" ? formatMs : (n: number) => String(n);
      const worst = effort.max[key] > effort.median[key] ? `, max ${render(effort.max[key])}` : "";
      return `${render(effort.median[key])} ${label}${worst}`;
    };
    console.log(
      `  per run    ${pair("rounds")} · ${pair("toolCalls")} · ${pair("latencyMs")}   ${colour("(median)", DIM)}`,
    );
  }

  printStalls(report);
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

  // The second cut. Category says which subsystem is weak; this says whether the
  // model is failing the hard half of everything, which is a different finding
  // with a different fix — and it is the one that says where the ceiling is.
  // Only printed when the run spanned more than one level: a `--difficulty 5`
  // run would otherwise render a single bar identical to the overall score.
  const levels = Object.keys(s.byDifficulty ?? {}).sort();
  if (levels.length > 1) {
    console.log("");
    for (const level of levels) {
      const bucket = s.byDifficulty?.[level];
      if (!bucket) continue;
      const pct = `${Math.round(bucket.rate * 100)}%`.padStart(4);
      console.log(
        `  ${describeDifficulty(Number(level)).padEnd(width)}  ${colour(bar(bucket.rate), rateColour(bucket.rate))} ${pct}  ${colour(`${bucket.passed}/${bucket.total}`, DIM)}`,
      );
    }
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
