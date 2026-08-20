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
import { declaredTokenNames, mintToken, mintTokens, substituteTokens, witnessCollides } from "../tokens.js";
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

function outcome(reply: string, stop?: RunOutcome["stop"]): RunOutcome {
  return {
    reply,
    calls: [],
    executions: [],
    posts: [],
    requests: [],
    latencyMs: 0,
    usage: { input: 0, output: 0 },
    stop,
  };
}

/**
 * Both observed in real runs, both once scored as passes.
 *
 * `silent` is the loop returning nothing. `stall` is the repeated-call detector
 * firing — a turn that ended because the agent was going in circles, which is
 * the failure most worth catching and the one a blacklist most readily accepts.
 *
 * The stall case carries ordinary prose and a structured stop, because that is
 * what a stall actually looks like: the loop gets one tools-withheld call so it
 * can explain itself, and all 12 stalls in a 237-run cohort came back as prose
 * with no `[Agent stopped: …]` marker anywhere. A fixture built from the marker
 * was testing a string nothing produces.
 */
const DEGENERATE: Array<{ name: string; outcome: RunOutcome }> = [
  { name: "said nothing and did nothing", outcome: outcome("") },
  {
    name: "went in circles and answered anyway",
    outcome: outcome("Sure — let me know if there is anything else.", { kind: "repeated-calls", period: 1 }),
  },
];

/**
 * A rubric judge on an empty reply fails, so a scenario carrying one does
 * discriminate. Stubbed rather than skipped: skipping would quietly exempt
 * every `judge` scenario from this file.
 */
const rejectingJudge = async () => ({ pass: false, reason: "stub: degenerate reply" });

const { scenarios: everyScenario } = await loadScenarios(scenarioDir);

/**
 * A `review:` row is not exempt from discriminating — it makes no claim to
 * discriminate at all.
 *
 * It has no `expect` by construction: the schema refuses to let one carry
 * assertions, because a review scenario's output is an artifact a person opens
 * and its simulation reports activity counts that must never become a score.
 * There is therefore nothing here for a degenerate outcome to fail against, and
 * including these rows would only lower the coverage ratio below with rows that
 * cannot raise it.
 */
const scenarios = everyScenario.filter((s) => !s.review);

describe("every scenario rejects a degenerate outcome", () => {
  const graded = scenarios.filter((s) => behaviourAssertions(s).length > 0);

  it("covers most of the set (prompt-shape rows are legitimately exempt)", () => {
    expect(graded.length).toBeGreaterThan(scenarios.length * 0.6);
  });

  // A witness scenario has a property the others cannot: there is a specific
  // string the reply must carry, and it was minted for this run. So a reply that
  // is *plausible but carries no witness* has to fail — that is the whole reason
  // for minting one. Checked offline, against a value from a different mint,
  // which is exactly what a confabulating agent would produce.
  //
  // This is the only part of a witness conversion that can be verified without a
  // model: it proves the assertion is bound to the witness. Whether the model
  // can satisfy it is a separate question, and needs a run.
  // Only scenarios that require a witness to be *present*. Where the witness is
  // used negatively — `reply_mentions_none`, asserting the agent did not leak
  // another room's content — a reply that carries no witness is the *correct*
  // outcome, and demanding it fail would be backwards.
  const POSITIVE_WITNESS = new Set([
    "reply_mentions_any",
    "reply_mentions_all",
    "reply_matches",
    "tool_args",
    "calls_by",
  ]);
  const witnessed = scenarios.filter(
    (s) =>
      declaredTokenNames(s.tokens).length > 0 &&
      s.expect.some((a) => POSITIVE_WITNESS.has(kindOf(a)) && JSON.stringify(a).includes("{{token:")),
  );

  for (const scenario of witnessed) {
    it(`${scenario.id} — its assertions are bound to the witness, not to a guessable value`, async () => {
      const mine = mintTokens(scenario.tokens ?? []);
      const scoped = substituteTokens(scenario, mine);
      // Values from a different run — which is what a confabulating agent
      // produces, and what must not satisfy the assertions.
      //
      // Re-minted until no foreign value could be mistaken for any of `mine` —
      // by the same non-containment rule a single run mints under, and against
      // the whole set rather than each token's counterpart.
      //
      // Both halves of that were learned here. `does-not-answer-from-a-
      // superseded-fact` carries two `day` witnesses and asserts "mentions the
      // new date" and "does not mention the withdrawn one", so the foreign reply
      // only has to contain `mine.newdate` *anywhere* to satisfy the first: a
      // cross-token collision, twice as likely as the same-token one. And `3rd`
      // is a substring of `23rd`, so even distinct values collide under a
      // substring assertion. Together they failed this suite on a healthy
      // scenario about one run in eight — the shape of flake that teaches
      // everyone to re-run instead of read.
      const ours = new Set(Object.values(mine));
      const theirs = Object.keys(mine).map((name) => {
        const format = Array.isArray(scenario.tokens) ? "code" : (scenario.tokens?.[name] ?? "code");
        let value = mintToken(format);
        // Bounded, and giving up is safe: a format with fewer usable values than
        // the scenario has tokens degrades this check to matching nothing rather
        // than hanging.
        for (let attempt = 0; attempt < 50 && witnessCollides(value, ours); attempt++) value = mintToken(format);
        return value;
      });
      const foreign = theirs.join(" ");

      const checks = await grade({ ...scoped, expect: behaviourAssertions(scoped) } as Scenario, outcome(foreign), {
        judge: rejectingJudge,
      });

      expect(
        checks.every((c) => c.pass),
        `"${scenario.id}" accepts a reply carrying witness values from a different run. ` +
          "Its assertions still match something guessable, so the witness is decoration — " +
          "check that every reply assertion references {{token:...}}.",
      ).toBe(false);
    });
  }

  for (const scenario of graded) {
    // An agent that did nothing leaves the machinery untouched, so a scenario
    // with a `world` has to be handed its *initial* state rather than no state
    // at all. Without this the `world_state` check skips — absent input is
    // graded as unknown — and a scenario whose only assertion is the goal looks
    // like it accepts an agent that never moved. Which is the exact failure
    // this file exists to catch, arriving through the door it just opened.
    const untouched = {
      ...(scenario.world ? { world: { ...scenario.world.state }, worldLog: [] } : {}),
      // Same rule for the oracle: an agent that did nothing submitted nothing,
      // which is an empty list and not an absent one. Absent means "this run
      // predates the field" and is graded as unknown, so without this a scenario
      // whose only assertion is `answers_correctly` would appear to accept an
      // agent that never opened its mouth.
      ...(scenario.oracle ? { guesses: [] } : {}),
    };

    // A scenario may declare that silence is the right answer — an
    // acknowledgement addressed to nobody deserves no reply. Then "said
    // nothing" is the *expected* outcome, not a degenerate one, and only the
    // stall case applies. Declaring it with `replies: false` is what makes the
    // exemption explicit rather than a hole; a stall still fails, because the
    // grader rejects one on either setting.
    const silenceIsCorrect = scenario.expect.some((a) => a.replies === false);
    const cases = silenceIsCorrect ? DEGENERATE.filter((d) => d.outcome.stop !== undefined) : DEGENERATE;

    for (const degenerate of cases) {
      it(`${scenario.id} — rejects an agent that ${degenerate.name}`, async () => {
        const checks = await grade(
          { ...scenario, expect: behaviourAssertions(scenario) } as Scenario,
          { ...degenerate.outcome, ...untouched },
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
