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
  it("writes its own history budget when a scenario says nothing", () => {
    // The baseline the removal case is measured against — if this ever stops
    // being written, the null test below would pass for the wrong reason.
    expect(agentOf(scenario())).toHaveProperty("maxHistoryTokens", 110000);
  });

  it("removes a key set to null, so loadConfig supplies the code default", () => {
    const agent = agentOf(scenario({ agent: { maxHistoryTokens: null } }));
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
    const agent = agentOf(scenario({ agent: { temperature: 0.9 } }));
    expect(agent.temperature).toBe(0.9);
    expect(agent).toHaveProperty("maxHistoryTokens", 110000);
  });

  it("can remove a whole section, not just a leaf", () => {
    const config = buildConfig(scenario({ channels: null }), OPTS);
    expect(config).not.toHaveProperty("channels");
  });
});
