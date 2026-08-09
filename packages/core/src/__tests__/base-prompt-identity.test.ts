/**
 * The base prompt used to open with "Check your context and memory for your
 * identity" — an instruction to spend a tool call fetching something already in
 * the request. `core_memory` and `context` are prompt *layers*, composed a few
 * hundred tokens below the base one, so there was never anything to look up.
 *
 * The cost was where it sat rather than the lookup itself: the first
 * instruction of the first layer, telling the model to reach for memory before
 * reading anything. Measured on the benchmark's `does-not-search-memory-for-what-it-was-just-told`
 * over 15 runs per arm, a 27B model went from answering with no tool call at all
 * **0 times out of 15** to **5 out of 15**, and from opening with a lookup 5/15
 * to 2/15. The full 58-scenario set moved no row beyond the noise floor, so the
 * shared prompt got cheaper without costing anything elsewhere.
 *
 * Two things are pinned here. The regression is obvious; the layer order is not,
 * and it is the one that would rot silently — the wording says the identity
 * appears *below*, which is a claim about `DEFAULT_LAYER_ORDER`. Reorder the
 * layers so `core_memory` precedes `base` and the sentence becomes a lie that no
 * type checker would catch.
 */

import { describe, expect, it } from "vitest";
import { BASE_SYSTEM_PROMPT, buildBaseSystemPrompt } from "../agent/prompt.js";
import { DEFAULT_LAYER_ORDER } from "../agent/system-prompt.js";

describe("the base prompt's identity paragraph", () => {
  it("does not send the agent looking for an identity that is already in the request", () => {
    // Any imperative to go and fetch it. The failure mode is behavioural, not
    // textual, so this guards the shape rather than one exact sentence.
    expect(BASE_SYSTEM_PROMPT).not.toMatch(/\b(check|search|look ?up|query|retrieve)\b[^.]*\bmemory\b/i);
  });

  it("still tells an unnamed agent to introduce itself and save the name", () => {
    // The paragraph's actual job, which the rewrite must not have dropped: this
    // is the only path by which a fresh install ever acquires a persona.
    expect(BASE_SYSTEM_PROMPT).toMatch(/introduce yourself/i);
    expect(BASE_SYSTEM_PROMPT).toMatch(/save the name/i);
  });

  it("places the identity layers below the base layer, so 'below' is true", () => {
    const base = DEFAULT_LAYER_ORDER.indexOf("base");
    expect(base).toBe(0);
    for (const layer of ["context", "core_memory"] as const) {
      expect(DEFAULT_LAYER_ORDER.indexOf(layer)).toBeGreaterThan(base);
    }
  });

  it("costs no more than it did, since every agent pays for it every turn", () => {
    // The rewrite removed a sentence and shortened another. A future edit that
    // grows this paragraph should be a deliberate decision, not a drift.
    expect(BASE_SYSTEM_PROMPT.length).toBeLessThan(1100);
  });

  it("keeps the self-modification paragraph opt-in", () => {
    // Unrelated to the identity change, but the same prompt: an agent without
    // admin tools should not be told it can reconfigure itself.
    expect(buildBaseSystemPrompt().length).toBeLessThan(buildBaseSystemPrompt({ selfModifying: true }).length);
  });
});
