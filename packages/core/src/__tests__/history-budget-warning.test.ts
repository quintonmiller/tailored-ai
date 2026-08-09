/**
 * A history budget that cannot hold a single message is not a tuning choice, it
 * is a misconfiguration that presents as amnesia.
 *
 * `historyBudget = maxHistoryTokens − systemPrompt − tail − toolSchemas`, and
 * since #421 the schemas are the dominant term: ~5,500 tokens for 24 tools,
 * ~10,900 for the reference deployment's 41. `DEFAULT_CONFIG.maxHistoryTokens`
 * is 2,000 — under the floor before a message is counted. The scenario benchmark
 * caught it: at the default, a fact stated two messages earlier never reached
 * the model; at 20,000 it always did.
 *
 * Warned rather than floored, because raising the budget unasked would build a
 * request the model's context may refuse, and the right number depends on the
 * model.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetHistoryBudgetWarnings, warnIfNoHistoryFits } from "../agent/loop.js";

const healthy = {
  maxHistoryTokens: 110_000,
  systemPromptTokens: 400,
  tailTokens: 100,
  toolSchemaTokens: 10_900,
  historyBudget: 98_600,
  historyLength: 40,
};

const starved = {
  maxHistoryTokens: 2_000,
  systemPromptTokens: 400,
  tailTokens: 100,
  toolSchemaTokens: 5_500,
  historyBudget: 0,
  historyLength: 12,
};

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetHistoryBudgetWarnings();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

describe("the starved-history-budget warning", () => {
  it("fires when nothing is left for the conversation", () => {
    warnIfNoHistoryFits(starved, "nova");
    expect(warn).toHaveBeenCalledOnce();
    const message = String(warn.mock.calls[0][0]);
    // The numbers are the point: "raise it" without saying above what is advice
    // nobody can act on.
    expect(message).toContain("2000");
    expect(message).toContain("6000");
    expect(message).toContain("tool schemas");
  });

  it("stays quiet when the budget is healthy", () => {
    warnIfNoHistoryFits(healthy, "nova");
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays quiet on a first turn, which has no history to lose", () => {
    warnIfNoHistoryFits({ ...starved, historyLength: 1 }, "nova");
    expect(warn).not.toHaveBeenCalled();
  });

  it("fires once per agent, not once per turn", () => {
    warnIfNoHistoryFits(starved, "nova");
    warnIfNoHistoryFits(starved, "nova");
    warnIfNoHistoryFits(starved, "nova");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("warns separately for a second agent, whose config may differ", () => {
    warnIfNoHistoryFits(starved, "nova");
    warnIfNoHistoryFits(starved, "scribe");
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
