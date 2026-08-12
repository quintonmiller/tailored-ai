/**
 * Does each scenario's `expect` block actually discriminate?
 *
 * A benchmark reports a number whatever it measures, so an assertion that
 * cannot fail is indistinguishable from a capability the agent has. Four
 * separate versions of that bug have cost a run each to diagnose:
 *
 *   - `does_not_call: [exec]` forbade `aws s3 ls` as firmly as the delete
 *   - `does_not_call: [recall, facts, …]` forbade *saving* what was just learned
 *   - `replies: true` was satisfied by `[Agent stopped: …]`, so two stall
 *     markers scored as passes on a 12-run baseline
 *   - a `toolResults` stub for a tool the agent could not reach made the
 *     scenario impossible, and it failed looking exactly like a model limit
 *
 * The last two are now structurally impossible (the schema rejects unreachable
 * stubs; this file rejects the rest). The shape they share: the assertions were
 * read and looked right. Reading is the part that keeps failing, so this checks
 * them by construction instead.
 *
 * Method: replay each scenario's assertions against outcomes that are *known
 * bad* — the agent produced nothing, or produced a stop marker. These are not
 * hypotheticals; both are real observed outcomes that were once scored as
 * passes. If a scenario accepts one, its number is not evidence.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { grade } from "../graders.js";
import { loadScenarios } from "../schema.js";
import type { Assertion, RunOutcome, Scenario } from "../types.js";

const scenarioDir = join(dirname(fileURLToPath(import.meta.url)), "../../scenarios");

/**
 * Assertions about the request we built, not about what the agent did.
 *
 * A scenario made only of these is measuring prompt assembly — the prompt
 * exists whether or not the agent says anything, so "the agent did nothing" is
 * not a degenerate case for it. Excluded rather than exempted per-scenario, so
 * a new prompt-shape row needs no allowlist entry.
 */
const PROMPT_KINDS = new Set(["prompt_contains", "prompt_not_contains", "prompt_occurrences", "prompt_max_tokens"]);

function kindOf(assertion: Assertion): string {
  return Object.keys(assertion).find((k) => assertion[k as keyof Assertion] !== undefined) ?? "";
}

function behaviourAssertions(scenario: Scenario): Assertion[] {
  return scenario.expect.filter((a) => !PROMPT_KINDS.has(kindOf(a)));
}

function outcome(reply: string): RunOutcome {
  return { reply, calls: [], posts: [], requests: [], latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0 } };
}

/**
 * Both observed in real runs, both once scored as passes.
 *
 * `silent` is the loop returning nothing. `stall` is the repeated-call detector
 * firing — a turn that ended because the agent was going in circles, which is
 * the failure most worth catching and the one a blacklist most readily accepts.
 */
const DEGENERATE: Array<{ name: string; outcome: RunOutcome }> = [
  { name: "said nothing and did nothing", outcome: outcome("") },
  { name: "returned a stop marker", outcome: outcome("[Agent stopped: repeated identical tool calls detected]") },
];

/**
 * A rubric judge on an empty reply fails, so a scenario carrying one does
 * discriminate. Stubbed rather than skipped: skipping would quietly exempt
 * every `judge` scenario from this file.
 */
const rejectingJudge = async () => ({ pass: false, reason: "stub: degenerate reply" });

const { scenarios } = loadScenarios(scenarioDir);

describe("every scenario rejects a degenerate outcome", () => {
  const graded = scenarios.filter((s) => behaviourAssertions(s).length > 0);

  it("covers most of the set (prompt-shape rows are legitimately exempt)", () => {
    expect(graded.length).toBeGreaterThan(scenarios.length * 0.6);
  });

  for (const scenario of graded) {
    // A scenario may declare that silence is the right answer — an
    // acknowledgement addressed to nobody deserves no reply. Then "said
    // nothing" is the *expected* outcome, not a degenerate one, and only the
    // stall case applies. Declaring it with `replies: false` is what makes the
    // exemption explicit rather than a hole; a stall still fails, because the
    // grader rejects one on either setting.
    const silenceIsCorrect = scenario.expect.some((a) => a.replies === false);
    const cases = silenceIsCorrect ? DEGENERATE.filter((d) => d.name.includes("stop marker")) : DEGENERATE;

    for (const degenerate of cases) {
      it(`${scenario.id} — rejects an agent that ${degenerate.name}`, async () => {
        const checks = await grade(
          { ...scenario, expect: behaviourAssertions(scenario) } as Scenario,
          degenerate.outcome,
          {
            judge: rejectingJudge,
          },
        );
        const accepted = checks.every((c) => c.pass);

        // The message matters more than the assertion here: whoever hits this is
        // being told their scenario reports a pass for an agent that did nothing.
        expect(
          accepted,
          `"${scenario.id}" passes every behaviour assertion for an agent that ${degenerate.name}.\n` +
            `Its assertions are [${behaviourAssertions(scenario).map(kindOf).join(", ")}] — all prohibitions, ` +
            "so doing nothing satisfies them. Add an assertion that requires the right thing to happen " +
            "(reply_matches / reply_mentions_any / calls_tool / posts_by), not just the wrong thing to be absent.",
        ).toBe(false);
      });
    }
  }
});
