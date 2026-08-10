/**
 * What a run cost in effort, as opposed to whether it was right.
 *
 * The score saturates. Once every scenario passes there is nothing left for it
 * to say, and a benchmark whose only number is a pass rate stops being useful
 * on the day it succeeds. Everything here is the other axis: how many rounds,
 * how many tool calls, how long, how many tokens — the numbers that keep moving
 * after correctness has stopped.
 *
 * It is also the blind spot that survived #468. That change made a request
 * growing visible; a change that holds the score and doubles the *tool calls*,
 * or adds a round to every turn, is still invisible today. Both are the same
 * failure this benchmark exists to catch — work growing without anyone deciding
 * it should.
 *
 * Nothing new is measured. Every field below is already in every report:
 * `latencyMs` and `usage` per run, `calls[]` per run, and one `requests[]` entry
 * per model round — `worker.ts` blanks the prompt text of a passing run but
 * keeps the entry. So this reads old reports as happily as new ones, and no
 * re-run is needed to get a number for a run that happened last month.
 */

import type { RunResult, ScenarioResult } from "./types.js";

export interface Effort {
  /** Model round-trips: one per request the loop sent. */
  rounds: number;
  toolCalls: number;
  /** Wall clock for the whole run, including tool execution. */
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface EffortSummary {
  runs: number;
  /**
   * Median, not mean.
   *
   * The tail is where the interesting runs are: the current cohort has 78 runs
   * making no tool call and two making eleven. A mean folds those two into the
   * background; a median leaves them visible as a gap between median and max,
   * which is the shape worth looking at.
   */
  median: Effort;
  max: Effort;
  total: Effort;
}

const ZERO: Effort = { rounds: 0, toolCalls: 0, latencyMs: 0, inputTokens: 0, outputTokens: 0 };

export const EFFORT_KEYS = ["rounds", "toolCalls", "latencyMs", "inputTokens", "outputTokens"] as const;

export function effortOf(run: RunResult): Effort {
  const outcome = run.outcome;
  return {
    rounds: outcome?.requests?.length ?? 0,
    toolCalls: outcome?.calls?.length ?? 0,
    latencyMs: outcome?.latencyMs ?? 0,
    inputTokens: outcome?.usage?.input ?? 0,
    outputTokens: outcome?.usage?.output ?? 0,
  };
}

/** Lower median of a sorted list — a real observation, never an average of two. */
function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

export function summariseEffort(runs: RunResult[]): EffortSummary {
  const efforts = runs.map(effortOf);
  const pick = (key: keyof Effort) => efforts.map((e) => e[key]);

  const build = (fn: (values: number[]) => number): Effort =>
    Object.fromEntries(EFFORT_KEYS.map((key) => [key, fn(pick(key))])) as unknown as Effort;

  return {
    runs: runs.length,
    median: build(median),
    max: build((values) => (values.length ? Math.max(...values) : 0)),
    total: build((values) => values.reduce((a, b) => a + b, 0)),
  };
}

export function summariseScenarios(scenarios: ScenarioResult[]): EffortSummary {
  return summariseEffort(scenarios.flatMap((s) => s.runs ?? []));
}

/**
 * Effort divided by runs, so two reports with different `--repeats` compare.
 *
 * The same rule the token comparison follows: a run that repeated twice as often
 * did twice as much work, and reporting that as a regression would be comparing
 * the invocation, not the code.
 */
export function perRun(summary: Pick<EffortSummary, "runs" | "total">): Effort {
  if (!summary.runs) return { ...ZERO };
  return Object.fromEntries(EFFORT_KEYS.map((key) => [key, summary.total[key] / summary.runs])) as unknown as Effort;
}

/** `1.2s`, `340ms`, `2m 05s` — readable at the three scales a turn actually takes. */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;
}

/** How a given metric is written when it is reported. */
export const EFFORT_LABELS: Record<keyof Effort, { label: string; format: (n: number) => string }> = {
  rounds: { label: "rounds", format: (n) => n.toFixed(n < 10 ? 1 : 0) },
  toolCalls: { label: "tool calls", format: (n) => n.toFixed(n < 10 ? 1 : 0) },
  latencyMs: { label: "latency", format: formatMs },
  inputTokens: { label: "input tokens", format: (n) => Math.round(n).toLocaleString("en-US") },
  outputTokens: { label: "output tokens", format: (n) => Math.round(n).toLocaleString("en-US") },
};
