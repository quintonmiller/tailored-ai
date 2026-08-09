/**
 * The default has to clear the floor it is measured against.
 *
 * `DEFAULT_CONFIG.maxHistoryTokens` was 2,000, set before #421 made tool
 * schemas count against the budget. After that change it sat under the overhead
 * of every real tool set, so
 *
 *     historyBudget = max(0, maxHistoryTokens − systemPrompt − tail − toolSchemas)
 *
 * clamped to zero on an untuned install: the whole conversation dropped on every
 * turn, indistinguishable from a model that cannot remember anything.
 *
 * These are not assertions that the number is 20,000 — a test that restates a
 * constant fails when the constant is improved and proves nothing when it is
 * wrong. They assert the *relationships* that made 2,000 a bug, so any future
 * value has to satisfy them too.
 *
 * The measured overheads are from the scenario benchmark's own fixtures: its
 * 24-tool agent produces a ~6,200-token request before any history, and a
 * 41-tool deployment measured ~10,900 in tool schemas alone.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, validateConfig } from "../config.js";

/** What a request costs before a single message is added. */
const OVERHEAD_24_TOOLS = 6_200;
const OVERHEAD_41_TOOLS = 10_900 + 400 + 100; // schemas + system prompt + tail

const budget = (overhead: number) => DEFAULT_CONFIG.agent.maxHistoryTokens - overhead;

describe("the default history budget", () => {
  it("leaves room for a conversation on a 24-tool agent, not just for the schemas", () => {
    // Clearing the floor by one token is not clearing it: the point of the
    // budget is the conversation, so require it to be the larger share.
    expect(budget(OVERHEAD_24_TOOLS)).toBeGreaterThan(OVERHEAD_24_TOOLS);
  });

  it("still leaves a usable conversation on a 41-tool deployment", () => {
    // Roughly a dozen turns of ordinary chat. Below this the agent is trimming
    // on every turn of a normal conversation, which is the failure in slow
    // motion rather than a different one.
    expect(budget(OVERHEAD_41_TOOLS)).toBeGreaterThan(5_000);
  });

  it("fits the default model window with room left for the reply", () => {
    // The budget caps the request; the window has to hold the request *and*
    // what the model generates into it.
    expect(DEFAULT_CONFIG.agent.maxHistoryTokens).toBeLessThan(DEFAULT_CONFIG.agent.maxContextTokens);
  });

  it("passes its own validation", () => {
    // The guard below must not fire on the shipped defaults — a config that
    // warns out of the box teaches operators to ignore warnings.
    const warnings = validateConfig(structuredClone(DEFAULT_CONFIG));
    expect(warnings.filter((w) => w.includes("maxHistoryTokens"))).toEqual([]);
  });
});

describe("validateConfig on the two token ceilings", () => {
  const withAgent = (over: { maxHistoryTokens?: number; maxContextTokens?: number }) => {
    const config = structuredClone(DEFAULT_CONFIG);
    Object.assign(config.agent, over);
    return validateConfig(config).filter((w) => w.includes("maxHistoryTokens"));
  };

  // Both values are set explicitly here. Leaning on the default would make
  // these tests fail the day someone changes it for an unrelated reason, and
  // report the guard as broken when it is not.
  it("warns when the request budget exceeds the model's window", () => {
    // The realistic mistake: a small-context model, and a budget nobody lowered.
    const warnings = withAgent({ maxHistoryTokens: 20_000, maxContextTokens: 8_192 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/8192/);
    expect(warnings[0]).toMatch(/reply/);
  });

  it("warns when they are merely equal, since the reply needs room too", () => {
    expect(withAgent({ maxHistoryTokens: 8_192, maxContextTokens: 8_192 })).toHaveLength(1);
  });

  it("stays quiet when the window is the larger of the two", () => {
    expect(withAgent({ maxContextTokens: 200_000 })).toEqual([]);
    expect(withAgent({ maxHistoryTokens: 4_000, maxContextTokens: 8_192 })).toEqual([]);
  });
});
