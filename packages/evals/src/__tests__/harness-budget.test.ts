/**
 * What the benchmark tells TAI about its own limits.
 *
 * The benchmark's whole job is to connect TAI to a problem and let TAI behave
 * as it would in a deployment. A value the harness writes for itself is a value
 * the benchmark measures itself against instead — and on 2026-08-17 one of them
 * cost a run.
 *
 * `buildConfig` hardcoded `maxHistoryTokens: 110000`: 5.5x core's default budget
 * and 3.4x core's default window. Nothing needed it. Every scenario that sets a
 * budget sets a smaller one, and the sixteen of twenty scenario files that set
 * none inherited a budget no request could ever reach — so `trimHistory` never
 * bound, the descent's prompts grew to 44,913 tokens against a 32,768-token
 * server, and the run died at round 13 having played 130 turns with nobody in
 * them.
 *
 * `validateConfig` had already said so, in one sentence, before the first turn.
 * Nothing printed it.
 *
 * That the harness no longer writes a budget of its own is asserted where the
 * config is built, in `harness-config.test.ts`. This file is about the other
 * half: that core's verdict on the pair reaches a human.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, validateConfig } from "@tailored-ai/core";
import { describe, expect, it } from "vitest";
import { configWarningsToReport } from "../harness.js";

describe("what core says about a budget that cannot fit its window", () => {
  /**
   * Through `loadConfig`, the way the harness gets there — so the config under
   * test carries every default the real one does and the assertion is about the
   * two numbers rather than about which keys a hand-built object forgot.
   */
  const budgetWarnings = (maxHistoryTokens: number, maxContextTokens: number) => {
    const dir = mkdtempSync(join(tmpdir(), "budget-"));
    const path = join(dir, "config.yaml");
    writeFileSync(path, `agent:\n  maxHistoryTokens: ${maxHistoryTokens}\n  maxContextTokens: ${maxContextTokens}\n`);
    return validateConfig(loadConfig(path)).filter((w) => w.includes("maxHistoryTokens"));
  };

  it("warns on exactly the pair the descent run died on", () => {
    const warnings = budgetWarnings(110000, 32768);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("110000");
    expect(warnings[0]).toContain("32768");
  });

  it("says nothing when the budget fits the window", () => {
    expect(budgetWarnings(20000, 131072)).toEqual([]);
  });

  it("still warns when they are merely equal, which leaves no room for a reply", () => {
    expect(budgetWarnings(32768, 32768)).toHaveLength(1);
  });
});

describe("reporting those warnings", () => {
  it("reports a warning once, however many runs assemble the same config", () => {
    // The config is built per run. Ninety runs of a cohort would otherwise
    // print the same sentence ninety times, which is how a real warning gets
    // scrolled past.
    const seen = new Set<string>();
    const warnings = ["budget does not fit the window"];
    expect(configWarningsToReport(warnings, seen)).toEqual(warnings);
    expect(configWarningsToReport(warnings, seen)).toEqual([]);
    expect(configWarningsToReport(warnings, seen)).toEqual([]);
  });

  it("still reports a second, different warning", () => {
    const seen = new Set<string>();
    configWarningsToReport(["first"], seen);
    expect(configWarningsToReport(["first", "second"], seen)).toEqual(["second"]);
  });

  it("reports nothing when core is happy", () => {
    expect(configWarningsToReport([], new Set())).toEqual([]);
  });
});
