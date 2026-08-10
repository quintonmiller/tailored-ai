import { describe, expect, it } from "vitest";
import { effortOf, formatMs, perRun, summariseEffort, summariseScenarios } from "../efficiency.js";
import type { RunResult, ScenarioResult } from "../types.js";

/**
 * The axis the score cannot express.
 *
 * A pass rate saturates: once everything passes there is nothing left for it to
 * say, and this set is already at 92.7%. Rounds, tool calls and tokens keep
 * moving after correctness has stopped — and a change that holds every pass
 * rate while adding a round to each turn is exactly the shape this benchmark
 * exists to catch, one step out from the request growth #468 covered.
 */

function run(over: {
  rounds?: number;
  calls?: number;
  latencyMs?: number;
  input?: number;
  output?: number;
  pass?: boolean;
}): RunResult {
  return {
    pass: over.pass ?? true,
    checks: [],
    outcome: {
      reply: "",
      posts: [],
      calls: Array.from({ length: over.calls ?? 0 }, (_, i) => ({ name: `t${i}`, args: {} })),
      requests: Array.from({ length: over.rounds ?? 0 }, () => ({
        system: "",
        messages: [],
        toolNames: [],
        estimatedTokens: 0,
      })),
      usage: { input: over.input ?? 0, output: over.output ?? 0 },
      latencyMs: over.latencyMs ?? 0,
    },
  } as unknown as RunResult;
}

describe("effort per run", () => {
  it("counts a round per request, including a run whose bodies were dropped", () => {
    // `worker.ts` blanks `system` and `messages` for a passing run but keeps the
    // entry. If it did not, every efficiency number would be recoverable only
    // for failures — which is the wrong half.
    const stripped = run({ rounds: 3, calls: 2 });

    expect(effortOf(stripped)).toMatchObject({ rounds: 3, toolCalls: 2 });
  });

  it("reads zero out of a run that recorded nothing", () => {
    expect(effortOf({ pass: true, checks: [] } as unknown as RunResult)).toEqual({
      rounds: 0,
      toolCalls: 0,
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
    });
  });
});

describe("summarising a set of runs", () => {
  it("reports a median, not a mean, so one long tail run does not vanish", () => {
    // The real distribution: most runs make no tool call, a couple make eleven.
    // A mean says 1.4 and describes no run that happened.
    const runs = [run({ calls: 0 }), run({ calls: 0 }), run({ calls: 0 }), run({ calls: 0 }), run({ calls: 11 })];

    const summary = summariseEffort(runs);

    expect(summary.median.toolCalls).toBe(0);
    expect(summary.max.toolCalls).toBe(11);
    expect(summary.total.toolCalls).toBe(11);
  });

  it("takes a real observation as the median rather than averaging two", () => {
    const summary = summariseEffort([run({ rounds: 1 }), run({ rounds: 4 })]);

    // 2.5 rounds is not a thing that can happen.
    expect(summary.median.rounds).toBe(1);
  });

  it("survives an empty set", () => {
    const summary = summariseEffort([]);

    expect(summary.runs).toBe(0);
    expect(summary.median.rounds).toBe(0);
    expect(perRun(summary).rounds).toBe(0);
  });

  it("divides by runs, so a differing repeat count is not a finding", () => {
    const ten = summariseEffort(Array.from({ length: 10 }, () => run({ rounds: 2 })));
    const twenty = summariseEffort(Array.from({ length: 20 }, () => run({ rounds: 2 })));

    expect(perRun(ten).rounds).toBe(perRun(twenty).rounds);
    expect(ten.total.rounds).not.toBe(twenty.total.rounds);
  });

  it("counts failing runs too — an expensive failure is the expensive case", () => {
    const summary = summariseScenarios([
      { id: "a", runs: [run({ rounds: 1, pass: true }), run({ rounds: 9, pass: false })] },
    ] as unknown as ScenarioResult[]);

    expect(summary.total.rounds).toBe(10);
  });

  it("tolerates a scenario that errored and has no runs", () => {
    // The #462 shape: a worker that died leaves `runs` absent entirely.
    const summary = summariseScenarios([{ id: "dead", error: "worker died" }] as unknown as ScenarioResult[]);

    expect(summary.runs).toBe(0);
  });
});

describe("formatting a duration", () => {
  it("reads at the three scales a turn actually takes", () => {
    expect(formatMs(340)).toBe("340ms");
    expect(formatMs(16_668)).toBe("16.7s");
    expect(formatMs(125_000)).toBe("2m 05s");
  });
});
