/**
 * Running a policy across many seeds, and saying what came out.
 *
 * One run of a stochastic simulation ranks nothing. A machine that was going to
 * fail 30% of the time either did or did not, and the difference is worth more
 * than most decisions in the run — so a single number tells you about the seed,
 * not about the player. The only honest unit of measurement here is a
 * distribution.
 *
 * Which is also why the report leads with more than a mean. A policy that earns
 * more on average by risking bankruptcy is a different thing from one that
 * earns slightly less and never dies, and a mean cannot tell them apart. P10
 * and the bankruptcy rate are what separate them.
 */

import { createSimulation, type Policy, type SimMetrics } from "./types.js";

export interface SweepResult {
  policy: string;
  seeds: number[];
  runs: SimMetrics[];
}

/**
 * How many days pass between one decision and the next.
 *
 * A baseline acting every day against a management team that meets once a week
 * is not a comparison, it is a handicap — and it is the handicap that matters
 * most, because reacting sooner is precisely what the benchmark rewards. So the
 * cadence is a parameter, and `beats_baseline` runs the baseline at whatever
 * cadence the team was given.
 *
 * Why a team cannot simply meet daily: a horizon short enough to afford one turn
 * per day is short enough to invert the ladder. Below about thirty days the
 * random policy *wins*, because every competent action — buying stock,
 * maintaining a machine, hiring — costs money now and repays later, and the
 * horizon ends before the repayment. Cadence is what buys a horizon long enough
 * to be honest at a number of turns a model run can afford.
 */
export function runPolicy(simulation: string, policy: Policy, seed: number, days?: number, stride = 1): SimMetrics {
  const sim = createSimulation(simulation, { seed, ...(days === undefined ? {} : { days }) });
  // Act, then close the day, exactly as a team would. A policy that acts after
  // the day has advanced would be deciding on tomorrow's information.
  let guard = 0;
  while (!sim.done && guard++ < 10_000) {
    policy.act(sim);
    for (let i = 0; i < Math.max(1, stride) && !sim.done; i++) sim.advance();
  }
  return sim.metrics();
}

export function sweep(simulation: string, policy: Policy, seeds: number[], days?: number, stride = 1): SweepResult {
  return { policy: policy.name, seeds, runs: seeds.map((seed) => runPolicy(simulation, policy, seed, days, stride)) };
}

function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * q;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return low === high ? sorted[low] : sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

export interface Summary {
  policy: string;
  runs: number;
  mean: number;
  median: number;
  p10: number;
  p90: number;
  worst: number;
  stdev: number;
  bankruptcyRate: number;
  serviceLevel: number;
}

export function summarise(result: SweepResult, key = "enterpriseValue"): Summary {
  const values = result.runs.map((m) => m[key] ?? 0);
  const mean = values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / Math.max(1, values.length);
  return {
    policy: result.policy,
    runs: values.length,
    mean,
    median: quantile(values, 0.5),
    p10: quantile(values, 0.1),
    p90: quantile(values, 0.9),
    worst: Math.min(...values),
    stdev: Math.sqrt(variance),
    bankruptcyRate: result.runs.filter((m) => m.bankrupt === 1).length / Math.max(1, result.runs.length),
    serviceLevel: result.runs.reduce((sum, m) => sum + (m.serviceLevel ?? 0), 0) / Math.max(1, result.runs.length),
  };
}

const usd = (n: number) => {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n)}`;
};

/**
 * The table that makes a number mean something.
 *
 * Ordered as given rather than by score, so a baseline ladder reads in the
 * order somebody would reason about it: what does nothing sensible, what a
 * competent setup does, what attention adds.
 */
export function formatSweep(summaries: Summary[]): string {
  const width = Math.max(...summaries.map((s) => s.policy.length), 12);
  const header = `  ${"policy".padEnd(width)}  ${"mean".padStart(9)}  ${"median".padStart(9)}  ${"P10".padStart(9)}  ${"worst".padStart(9)}  ${"service".padStart(7)}  ${"bankrupt".padStart(8)}`;
  const rows = summaries.map(
    (s) =>
      `  ${s.policy.padEnd(width)}  ${usd(s.mean).padStart(9)}  ${usd(s.median).padStart(9)}  ${usd(s.p10).padStart(9)}  ${usd(s.worst).padStart(9)}  ${`${(s.serviceLevel * 100).toFixed(1)}%`.padStart(7)}  ${`${(s.bankruptcyRate * 100).toFixed(0)}%`.padStart(8)}`,
  );
  return [header, ...rows].join("\n");
}

/**
 * Is there anything to measure here?
 *
 * The check that has to pass before a single model call. A simulation where
 * every policy scores the same has no decisions in it, and every agent number
 * it produces afterwards is noise dressed as a finding. Comparing the weakest
 * and strongest baselines is the cheapest possible way to find that out.
 */
export function gradient(summaries: Summary[]): { spread: number; ordered: boolean } {
  const means = summaries.map((s) => s.mean);
  const spread = Math.max(...means) - Math.min(...means);
  const ordered = means.every((v, i) => i === 0 || v >= means[i - 1]);
  return { spread, ordered };
}
