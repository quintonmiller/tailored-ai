/**
 * A scenario can only measure a code default if the harness gets out of the way.
 *
 * `buildConfig` writes a value for everything it cares about — including
 * `maxHistoryTokens: 110000`, so the long-session scenarios have room to work
 * in. A scenario about *defaults* therefore had no way to reach one, and
 * `default-history-budget-keeps-the-conversation` settled for pinning `2000`
 * and calling that the default. It was, on the day it was written. The day the
 * default moved, that scenario would have gone on measuring the old number and
 * reporting the result as current — a benchmark drifting away from the code
 * while still looking green, which is the failure this whole package exists to
 * avoid.
 *
 * `null` in a scenario's `config` removes the key, so `loadConfig` supplies
 * `DEFAULT_CONFIG`'s value. These tests pin that, in both directions: an
 * ignored `null` puts the drift straight back, and a `null` that deleted too
 * eagerly would strip config a scenario meant to set.
 */

import { describe, expect, it } from "vitest";
import { clampRounds } from "../cli.js";
import { buildConfig, DEFAULT_BASE_URL, type HarnessOptions } from "../harness.js";
import type { Scenario } from "../types.js";

const OPTS: HarnessOptions = {
  baseUrl: DEFAULT_BASE_URL,
  model: "test-model",
  apiKey: "unused",
  temperature: 0.3,
  maxTokens: 2048,
  maxToolRounds: 6,
  providerExtra: {},
  seed: 1000,
  timeoutMs: 1000,
};

function scenario(config?: Record<string, unknown>): Scenario {
  return {
    id: "s",
    category: "c",
    intent: "i",
    message: "hello",
    expect: [{ replies: true }],
    ...(config ? { config } : {}),
  } as Scenario;
}

const agentOf = (s: Scenario) => buildConfig(s, OPTS).agent as Record<string, unknown>;

describe("buildConfig", () => {
  it("writes no history budget of its own, so core's applies", () => {
    // Reversed 2026-08-17. This used to assert `110000`, and called itself "the
    // baseline the removal case is measured against". It was measuring a number
    // the harness had invented for itself: 5.5x core's default budget and 3.4x
    // core's default window, which meant `trimHistory` never bound for the
    // sixteen of twenty scenario files that set no budget. A descent run grew
    // to 44,913 tokens against a 32,768-token server and died mid-horizon.
    //
    // A benchmark exists to show how TAI behaves. A budget it writes for itself
    // is a budget it measures itself against.
    expect(agentOf(scenario())).not.toHaveProperty("maxHistoryTokens");
  });

  it("writes one when a target asks for one", () => {
    // The replacement for what the test above used to guard: the removal case
    // below needs *some* key the harness actually writes, or it passes for the
    // wrong reason. This is that key, now that it is opt-in.
    const agent = buildConfig(scenario(), { ...OPTS, maxHistoryTokens: 40000 }).agent as Record<string, unknown>;
    expect(agent).toHaveProperty("maxHistoryTokens", 40000);
  });

  it("removes a key set to null, so loadConfig supplies the code default", () => {
    const agent = buildConfig(scenario({ agent: { maxHistoryTokens: null } }), {
      ...OPTS,
      maxHistoryTokens: 40000,
    }).agent as Record<string, unknown>;
    expect(agent).not.toHaveProperty("maxHistoryTokens");
  });

  it("removes only the key that was nulled", () => {
    const agent = agentOf(scenario({ agent: { maxHistoryTokens: null } }));
    expect(agent.temperature).toBe(0.3);
    expect(agent.maxToolRounds).toBe(6);
    expect(agent.defaultProvider).toBe("openai_compatible");
  });

  it("still overrides with a value, which is the common case", () => {
    expect(agentOf(scenario({ agent: { maxHistoryTokens: 20000 } })).maxHistoryTokens).toBe(20000);
  });

  it("merges nested objects rather than replacing them", () => {
    // `maxToolRounds` rather than `maxHistoryTokens`: the point is that setting
    // one key in `agent` keeps the others, and it needs a sibling the harness
    // still writes unconditionally.
    const agent = agentOf(scenario({ agent: { temperature: 0.9 } }));
    expect(agent.temperature).toBe(0.9);
    expect(agent).toHaveProperty("maxToolRounds", 6);
  });

  it("can remove a whole section, not just a leaf", () => {
    const config = buildConfig(scenario({ channels: null }), OPTS);
    expect(config).not.toHaveProperty("channels");
  });
});

describe("--rounds moves the roster and the horizon together", () => {
  /*
   * They are one number and were two, and the gap between them cost a
   * four-hour run.
   *
   * `clampRounds` set the simulation's horizon to `n` unconditionally while
   * only ever *shortening* the wake roster, so `--rounds 60` against a scenario
   * declaring 40 produced a sim that ran for 60 ticks and agents that stopped
   * at 40. The harness then runs a simulation on to its horizon under the last
   * decisions made — right for a factory, which keeps paying wages, and fatal
   * for a dungeon, where an unattended party is simply eaten. The trace showed
   * five characters at full health on tick 39 and five corpses on tick 55 with
   * no rounds in between, and the resulting wipe read as a balance signal.
   */
  const scenario = {
    id: "x",
    simulation: { name: "descent", days: 40 },
    wake: [{ room: "party", rounds: 40, agents: ["guardian"] }],
  } as unknown as Parameters<typeof clampRounds>[0];

  it("shortens both", () => {
    const cut = clampRounds(scenario, 8);
    expect(cut.simulation?.days).toBe(8);
    expect((cut.wake as Array<{ rounds: number }>)[0].rounds).toBe(8);
  });

  it("lengthens both, which is the half that was broken", () => {
    const long = clampRounds(scenario, 60);
    expect(long.simulation?.days).toBe(60);
    expect(
      (long.wake as Array<{ rounds: number }>)[0].rounds,
      "the roster stayed at the authored value while the horizon moved, so nobody played the difference",
    ).toBe(60);
  });
});

describe("what a tool call is recorded as saying", () => {
  it("records a refusal instead of a blank", async () => {
    /*
     * Core's `fail()` returns `{ success: false, output: "", error }` — the
     * message in `error`, an empty string in `output`. Preferring `output`
     * whenever it was a string therefore wrote every refused core-tool call
     * into the trace as nothing at all.
     *
     * Measured: 6 of 324 calls in one run and 10 of 429 in another, every one a
     * `room` post missing its `room` argument, every one followed by an
     * identical retry. The model saw the error; the record did not, so the cost
     * was invisible to the viewer and to anybody reading the trace after.
     */
    const { describeResult } = await import("../harness.js");
    expect(describeResult({ success: false, output: "", error: "room is required." })).toBe("room is required.");
    expect(describeResult({ success: true, output: "Posted." })).toBe("Posted.");
    // An output that exists still wins — an error field left set beside a real
    // result must not overwrite it.
    expect(describeResult({ success: true, output: "Posted.", error: "stale" })).toBe("Posted.");
  });
});
