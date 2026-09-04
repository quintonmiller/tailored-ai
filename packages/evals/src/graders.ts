/**
 * Turning one run into pass/fail.
 *
 * Every grader is a pure function of the recorded outcome, which is what makes
 * the benchmark debuggable: a failing check reports what it wanted and what it
 * got, and re-grading an old result file needs no model. The only impure one is
 * `judge`, and it is opt-out for exactly that reason.
 */

import { isStallStop } from "@tailored-ai/core";
import { agentRounds, invocationRequest } from "./harness.js";
import { formatFactTrace, reached, traceFacts } from "./routing.js";
import { simulationPolicies } from "./sim/index.js";
import { formatResponses, traceResponses } from "./sim/latency.js";
import { runPolicy } from "./sim/sweep.js";
import type { Assertion, CheckResult, MilestoneResult, RunOutcome, Scenario } from "./types.js";
import { everReached, formatWorldLog, unmetGoal } from "./world.js";

/**
 * Word-trigram overlap, as a fraction of the shorter text.
 *
 * The measure that identified repetition degeneration in production: a model
 * answering afresh scores ~0.1–0.2 against its own previous message, one that
 * has started re-emitting scores ~0.9. Trigrams rather than tokens because
 * single-word overlap is dominated by function words and says nothing.
 */
export function trigramOverlap(a: string, b: string): number {
  const grams = (text: string): Set<string> => {
    const words = text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
    const out = new Set<string>();
    for (let i = 0; i + 2 < words.length; i++) out.add(words.slice(i, i + 3).join(" "));
    return out;
  };
  const left = grams(a);
  const right = grams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared++;
  return shared / Math.min(left.size, right.size);
}

/** Money-sized numbers stay readable; small ones keep their digits. */
function formatNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${Math.round(value / 1_000)}K`;
  return String(Math.round(value * 1000) / 1000);
}

function ok(kind: string): CheckResult {
  return { kind, pass: true };
}

function no(kind: string, detail: string): CheckResult {
  return { kind, pass: false, detail };
}

/**
 * Not scored, because the input is missing rather than the behaviour.
 *
 * The same rule `prompt_*` follows on a report with no prompt text: an absent
 * input is unknown, never failure. Reading absence as failure is how `regrade`
 * turned 91.7% into 75.9% once, by grading fields that had been stripped.
 */
function skip(kind: string, detail: string): CheckResult {
  return { kind, pass: true, skipped: true, detail };
}

function promptText(outcome: RunOutcome): string {
  const first = invocationRequest(outcome.requests);
  if (!first) return "";
  return [first.system, ...first.messages.map((m) => m.content)].join("\n");
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function describeCalls(outcome: RunOutcome): string {
  if (outcome.calls.length === 0) return "no tool calls";
  return outcome.calls.map((c) => `${c.name}(${Object.keys(c.args).join(", ")})`).join(", ");
}

export type JudgeFn = (rubric: string, reply: string) => Promise<{ pass: boolean; reason: string }>;

export async function grade(
  scenario: Scenario,
  outcome: RunOutcome,
  opts: { judge?: JudgeFn } = {},
): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  // A run that threw never produced a request, so every check would fail for
  // the same reason. Report the cause once instead of N times.
  if (outcome.error) return [no("run", `the run failed: ${outcome.error}`)];

  for (const assertion of scenario.expect) {
    checks.push(await gradeOne(assertion, scenario, outcome, opts));
  }
  return checks;
}

/**
 * Which steps of progress this run reached.
 *
 * A milestone's `when` is an ordinary assertion, so this is the same grader the
 * `expect` block runs, called once per milestone and scored for partial credit
 * instead of pass/fail. That reuse is the whole design: a scenario that can
 * assert something can also award points for it, and no second predicate
 * language has to be kept in step with the first.
 *
 * A run that threw earns nothing rather than being skipped. The distinction the
 * skip rule protects — absent input is unknown, not failure — does not apply
 * here: the run had every chance and crashed, which is not a milestone reached.
 */
export async function scoreMilestones(
  scenario: Scenario,
  outcome: RunOutcome,
  opts: { judge?: JudgeFn } = {},
): Promise<MilestoneResult[]> {
  const results: MilestoneResult[] = [];
  for (const milestone of scenario.milestones ?? []) {
    if (outcome.error) {
      results.push({ id: milestone.id, points: milestone.points, reached: false, detail: "the run failed" });
      continue;
    }
    const check = await gradeOne(milestone.when, scenario, outcome, opts);
    results.push({
      id: milestone.id,
      points: milestone.points,
      // A skipped check is an absent input, not a step reached. Counting it
      // would hand full marks to a report that no longer carries the field.
      reached: check.pass && !check.skipped,
      ...(check.pass && !check.skipped ? {} : { detail: check.detail ?? "not reached" }),
    });
  }
  return results;
}

/** Earned, possible, and the fraction between them. Zero possible scores as zero, never as 1. */
export function milestoneScore(results: readonly MilestoneResult[]): {
  earned: number;
  possible: number;
  fraction: number;
} {
  const possible = results.reduce((sum, m) => sum + m.points, 0);
  const earned = results.filter((m) => m.reached).reduce((sum, m) => sum + m.points, 0);
  return { earned, possible, fraction: possible ? earned / possible : 0 };
}

async function gradeOne(
  assertion: Assertion,
  scenario: Scenario,
  outcome: RunOutcome,
  opts: { judge?: JudgeFn },
): Promise<CheckResult> {
  const reply = outcome.reply ?? "";

  if (assertion.calls_tool !== undefined) {
    const want = assertion.calls_tool;
    return outcome.calls.some((c) => c.name === want)
      ? ok("calls_tool")
      : no("calls_tool", `expected a call to ${want}; got ${describeCalls(outcome)}`);
  }

  if (assertion.calls_tool_any !== undefined) {
    const want = assertion.calls_tool_any;
    return outcome.calls.some((c) => want.includes(c.name))
      ? ok("calls_tool_any")
      : no("calls_tool_any", `expected one of ${want.join(" / ")}; got ${describeCalls(outcome)}`);
  }

  if (assertion.does_not_call !== undefined) {
    const banned = outcome.calls.filter((c) => assertion.does_not_call?.includes(c.name));
    return banned.length === 0
      ? ok("does_not_call")
      : no("does_not_call", `called ${[...new Set(banned.map((c) => c.name))].join(", ")}`);
  }

  if (assertion.tool_args !== undefined) {
    const { tool, where } = assertion.tool_args;
    const candidates = outcome.calls.filter((c) => c.name === tool);
    if (candidates.length === 0) return no("tool_args", `${tool} was never called; got ${describeCalls(outcome)}`);
    const matched = candidates.find((call) =>
      Object.entries(where).every(([key, expected]) => matchesArg(call.args[key], expected)),
    );
    if (matched) return ok("tool_args");
    const shown = candidates.map((c) => JSON.stringify(c.args)).join(" | ");
    return no("tool_args", `no ${tool} call matched ${JSON.stringify(where)}; saw ${shown}`);
  }

  if (assertion.does_not_call_with !== undefined) {
    const { tool, where } = assertion.does_not_call_with;
    // Both sides accept a list, meaning "any of these". A scenario that forbids
    // *looking things up* has to name four memory tools and their five read
    // actions; spelled one pair at a time that is twenty entries, and the
    // twentieth is the one nobody writes. The alternative people actually
    // reached for was `does_not_call: [recall, facts, …]`, which also forbids
    // *writing* — and scored an agent that answered correctly and saved a
    // durable fact as a failure.
    const tools = Array.isArray(tool) ? tool : [tool];
    const offending = outcome.calls
      .filter((c) => tools.includes(c.name))
      .filter((call) =>
        Object.entries(where).every(([key, expected]) =>
          Array.isArray(expected)
            ? expected.some((option) => matchesArg(call.args[key], option))
            : matchesArg(call.args[key], expected),
        ),
      );
    return offending.length === 0
      ? ok("does_not_call_with")
      : no("does_not_call_with", `${offending[0].name} was called with ${JSON.stringify(offending[0].args)}`);
  }

  if (assertion.calls_by !== undefined) {
    const want = assertion.calls_by;
    const ran = (outcome.executions ?? []).filter(
      (e) =>
        e.name === want.tool &&
        e.agent === want.agent &&
        (!want.where || Object.entries(want.where).every(([k, v]) => matchesArg(e.args[k], v))),
    );
    // Same default as `posts_by`: `min` is 1 unless a `max` says the point is
    // an upper bound, which a fixed 1 would make unsatisfiable.
    const min = want.min ?? (want.max === undefined ? 1 : 0);
    const describe = () => {
      const byAgent = (outcome.executions ?? []).map((e) => `${e.agent ?? "?"}:${e.name}`).join(", ");
      return byAgent || "nothing ran";
    };
    if (ran.length < min)
      return no("calls_by", `${want.agent} ran ${want.tool} ${ran.length}×, wanted ≥${min} (${describe()})`);
    if (want.max !== undefined && ran.length > want.max) {
      return no("calls_by", `${want.agent} ran ${want.tool} ${ran.length}×, wanted ≤${want.max} (${describe()})`);
    }
    return ok("calls_by");
  }

  if (assertion.posts_in !== undefined) {
    const want = assertion.posts_in;
    return outcome.posts.some((p) => p.room === want)
      ? ok("posts_in")
      : no("posts_in", `nothing posted in ${want}; posted in ${describeRooms(outcome)}`);
  }

  /**
   * Who spoke, and how often — the vocabulary a multi-agent scenario needs.
   *
   * `posts_in` asks whether anything landed in a room. With two agents taking
   * turns the interesting questions are different: did *this* agent speak
   * (a handoff arrived), did *nobody* (everyone deferred and the room went
   * silent), did everybody (one message woke the whole room).
   */
  if (assertion.posts_by !== undefined) {
    const want = assertion.posts_by;
    const spoke = outcome.posts.filter((p) => p.agent === want.agent);
    // `min` defaults to 1 — "did this agent speak" is the common question — but
    // only when no `max` was given. `posts_by: {agent, max: 0}` means "must not
    // speak", and a min of 1 would make it unsatisfiable by construction.
    const min = want.min ?? (want.max === undefined ? 1 : 0);
    const max = want.max;
    if (spoke.length < min) {
      return no("posts_by", `${want.agent} posted ${spoke.length}×, wanted ≥${min} (${describeSpeakers(outcome)})`);
    }
    if (max !== undefined && spoke.length > max) {
      return no("posts_by", `${want.agent} posted ${spoke.length}×, wanted ≤${max} (${describeSpeakers(outcome)})`);
    }
    // Whether the right agent said the right thing, which counting cannot ask.
    // `reply` on a room scenario is every post joined, so `reply_matches` passes
    // when *either* agent produced the text — and in a handoff the whole
    // question is whether the second one used what the first posted. That check
    // is true by construction the moment the first agent says the number.
    if (want.matches !== undefined) {
      const re = new RegExp(want.matches, "is");
      const hit = spoke.find((p) => re.test(p.body));
      if (!hit) {
        return no(
          "posts_by",
          spoke.length
            ? `${want.agent} said nothing matching /${want.matches}/: ${spoke.map((p) => `"${trim(p.body)}"`).join(" | ")}`
            : `${want.agent} never posted, so nothing could match /${want.matches}/ (${describeSpeakers(outcome)})`,
        );
      }
    }
    return ok("posts_by");
  }

  if (assertion.does_not_post_in !== undefined) {
    const banned = outcome.posts.filter((p) => assertion.does_not_post_in?.includes(p.room));
    return banned.length === 0
      ? ok("does_not_post_in")
      : no(
          "does_not_post_in",
          `posted in ${[...new Set(banned.map((p) => p.room))].join(", ")}: "${trim(banned[0].body)}"`,
        );
  }

  if (assertion.replies !== undefined) {
    // A stall is not an answer. `length > 0` accepted `[Agent stopped: …]` —
    // two of them scored as passes on a 12-run baseline — and accepts the more
    // common case too, where a turn that ran out of rounds returns ordinary
    // prose.
    //
    // Structural only. There used to be a fallback here that matched the marker
    // text when no stop was recorded, and it looked like coverage for the 56%
    // of runs that had none: measured on the 237-run cohort, all 12 stalls came
    // back as prose and not one carried a marker. A check that has never fired
    // is not a safety net, it is a reason not to go looking for the real one.
    // Room turns now report their stop, so the absent case is an old report —
    // and an absent input is graded as unknown, never as "did not stall".
    const stalled = outcome.stop !== undefined && isStallStop(outcome.stop);
    // Checked before the true/false split, so a stall fails either way. Silence
    // and a stall look identical downstream and are opposites: `replies: false`
    // asserts the agent *chose* not to speak, and a turn that went in circles
    // until the detector fired made no such choice.
    if (stalled) return no("replies", `the turn stalled (${outcome.stop?.kind})`);
    const replied = reply.trim().length > 0;
    if (replied === assertion.replies) return ok("replies");
    return no("replies", assertion.replies ? "said nothing" : `expected silence, said "${trim(reply)}"`);
  }

  if (assertion.reply_matches !== undefined) {
    const re = new RegExp(assertion.reply_matches, "is");
    return re.test(reply)
      ? ok("reply_matches")
      : no("reply_matches", `/${assertion.reply_matches}/ did not match "${trim(reply)}"`);
  }

  if (assertion.reply_not_matches !== undefined) {
    const re = new RegExp(assertion.reply_not_matches, "is");
    return re.test(reply)
      ? no("reply_not_matches", `/${assertion.reply_not_matches}/ matched "${trim(reply)}"`)
      : ok("reply_not_matches");
  }

  if (assertion.reply_mentions_any !== undefined) {
    const lower = reply.toLowerCase();
    const hit = assertion.reply_mentions_any.some((s) => lower.includes(s.toLowerCase()));
    return hit
      ? ok("reply_mentions_any")
      : no("reply_mentions_any", `none of [${assertion.reply_mentions_any.join(", ")}] in "${trim(reply)}"`);
  }

  if (assertion.reply_mentions_all !== undefined) {
    const lower = reply.toLowerCase();
    const missing = assertion.reply_mentions_all.filter((s) => !lower.includes(s.toLowerCase()));
    return missing.length === 0
      ? ok("reply_mentions_all")
      : no("reply_mentions_all", `missing [${missing.join(", ")}] from "${trim(reply)}"`);
  }

  if (assertion.reply_mentions_none !== undefined) {
    const lower = reply.toLowerCase();
    const found = assertion.reply_mentions_none.filter((s) => lower.includes(s.toLowerCase()));
    return found.length === 0
      ? ok("reply_mentions_none")
      : no("reply_mentions_none", `found [${found.join(", ")}] in "${trim(reply)}"`);
  }

  if (assertion.max_reply_chars !== undefined) {
    return reply.length <= assertion.max_reply_chars
      ? ok("max_reply_chars")
      : no("max_reply_chars", `${reply.length} chars > ${assertion.max_reply_chars}`);
  }

  if (assertion.min_reply_chars !== undefined) {
    return reply.length >= assertion.min_reply_chars
      ? ok("min_reply_chars")
      : no("min_reply_chars", `${reply.length} chars < ${assertion.min_reply_chars}`);
  }

  if (assertion.max_overlap !== undefined) {
    const { threshold, prior_reply, text } = assertion.max_overlap;
    const against = prior_reply ? lastAssistant(scenario) : text;
    if (against === undefined)
      return no("max_overlap", "nothing to compare against (no prior assistant line, no text)");
    const score = trigramOverlap(reply, against);
    return score <= threshold
      ? ok("max_overlap")
      : no("max_overlap", `trigram overlap ${score.toFixed(2)} > ${threshold} — the reply repeats "${trim(against)}"`);
  }

  if (assertion.prompt_contains !== undefined) {
    return promptText(outcome).includes(assertion.prompt_contains)
      ? ok("prompt_contains")
      : no("prompt_contains", `the request never contains "${assertion.prompt_contains}"`);
  }

  if (assertion.prompt_not_contains !== undefined) {
    return promptText(outcome).includes(assertion.prompt_not_contains)
      ? no("prompt_not_contains", `the request contains "${assertion.prompt_not_contains}"`)
      : ok("prompt_not_contains");
  }

  if (assertion.prompt_occurrences !== undefined) {
    const { text, min, max } = assertion.prompt_occurrences;
    const count = countOccurrences(promptText(outcome), text);
    if (min !== undefined && count < min)
      return no("prompt_occurrences", `"${trim(text)}" appears ${count}×, wanted ≥${min}`);
    if (max !== undefined && count > max)
      return no("prompt_occurrences", `"${trim(text)}" appears ${count}×, wanted ≤${max}`);
    return ok("prompt_occurrences");
  }

  if (assertion.prompt_max_tokens !== undefined) {
    const tokens = invocationRequest(outcome.requests)?.estimatedTokens ?? 0;
    return tokens <= assertion.prompt_max_tokens
      ? ok("prompt_max_tokens")
      : no("prompt_max_tokens", `~${tokens} tokens > ${assertion.prompt_max_tokens}`);
  }

  // Tripwires on effort rather than correctness. `prompt_max_tokens` above
  // guards the size of one request; these guard how many are sent and how much
  // is done — the way a turn gets expensive without getting wrong, which no
  // pass rate can express.
  if (assertion.max_rounds !== undefined) {
    const rounds = agentRounds(outcome.requests);
    return rounds <= assertion.max_rounds
      ? ok("max_rounds")
      : no("max_rounds", `${rounds} model rounds > ${assertion.max_rounds}`);
  }

  if (assertion.max_tool_calls !== undefined) {
    const calls = outcome.calls.length;
    return calls <= assertion.max_tool_calls
      ? ok("max_tool_calls")
      : no("max_tool_calls", `${calls} tool calls > ${assertion.max_tool_calls}`);
  }

  if (assertion.answers_correctly !== undefined) {
    if (!outcome.guesses) return skip("answers_correctly", "this run recorded no submitted answers");
    const within = typeof assertion.answers_correctly === "object" ? assertion.answers_correctly.within : Infinity;
    const at = outcome.guesses.findIndex((g) => g.correct);
    const solved = at !== -1;
    const wanted = assertion.answers_correctly !== false;

    if (!wanted) {
      return solved ? no("answers_correctly", `answered correctly on attempt ${at + 1}`) : ok("answers_correctly");
    }
    // The sequence, not just the count. Three different fabrications reads
    // nothing like one guess followed by a concession, and that difference is
    // the entire reason for handing the agent an oracle rather than grading its
    // first answer — so it goes in the failure text where it will be read.
    const trail = outcome.guesses.map((g) => `"${trim(g.answer)}"${g.correct ? " ✓" : ""}`).join(" → ");
    if (!solved) {
      return no(
        "answers_correctly",
        outcome.guesses.length === 0
          ? "never submitted an answer"
          : `never got it in ${outcome.guesses.length} attempt(s): ${trail}`,
      );
    }
    if (at + 1 > within) {
      return no("answers_correctly", `took ${at + 1} attempts, wanted it within ${within}: ${trail}`);
    }
    return ok("answers_correctly");
  }

  if (assertion.world_state !== undefined) {
    // Absent means the report predates worlds, or this scenario has none. Graded
    // as unknown and skipped, never as failure — the rule every input-dependent
    // check here follows, and the one that stops `regrade` inventing regressions
    // out of a field that did not exist yet.
    if (!outcome.world) return skip("world_state", "this run recorded no world state");
    const wanted = assertion.world_state === "goal" ? (scenario.world?.goal ?? {}) : assertion.world_state;
    if (Object.keys(wanted).length === 0) {
      return no("world_state", 'asserted "goal", but the scenario declares no goal');
    }
    const unmet = unmetGoal(outcome.world, wanted);
    if (unmet.length === 0) return ok("world_state");
    // The trace, not just the miss. A scenario that withholds the procedure has
    // no single right transcript, so "which door did it never open" is only
    // answerable from the machinery's side — and it is the whole diagnosis.
    const attempts = formatWorldLog(outcome.worldLog ?? []);
    // Capped, because a stuck agent retries: one run produced the same blocked
    // call eleven times and the useful part was the first two lines. The head is
    // what says which door it went to first, which is the part that explains the
    // rest.
    const shown = attempts.slice(0, 8);
    const more = attempts.length > shown.length ? ` (+${attempts.length - shown.length} more)` : "";
    const trace = attempts.length ? ` — did: ${shown.join("; ")}${more}` : " — touched nothing";
    return no("world_state", `${unmet.map((u) => `${u.key} is ${u.got}, wanted ${u.want}`).join("; ")}${trace}`);
  }

  if (assertion.world_reached !== undefined) {
    if (!outcome.world) return skip("world_reached", "this run recorded no world state");
    // An old report has a final state and no `sets` on its log entries, so the
    // transitions are invisible and only the endpoints can be checked. Graded
    // rather than skipped: the endpoints are real evidence, and the worst case
    // is the same answer `world_state` would have given.
    const unmet = everReached(scenario.world?.state, outcome.world, outcome.worldLog, assertion.world_reached);
    if (unmet.length === 0) return ok("world_reached");
    const attempts = formatWorldLog(outcome.worldLog ?? []);
    const shown = attempts.slice(0, 8);
    const more = attempts.length > shown.length ? ` (+${attempts.length - shown.length} more)` : "";
    const trace = attempts.length ? ` — did: ${shown.join("; ")}${more}` : " — touched nothing";
    return no("world_reached", `${unmet.map((u) => `${u.key} was never ${u.want}`).join("; ")}${trace}`);
  }

  if (assertion.fact_reaches !== undefined) {
    const { fact, stage } = assertion.fact_reaches;
    const spec = scenario.facts?.[fact];
    if (!spec) return no("fact_reaches", `no fact named "${fact}" — declared: [${Object.keys(scenario.facts ?? {})}]`);
    // Absent executions mean an old report, not a run in which nothing ran: the
    // field postdates the first reports and every stage below reads it.
    if (!outcome.executions) return skip("fact_reaches", "this run recorded no executions");
    const trace = traceFacts({ [fact]: spec }, outcome)[0];
    if (reached(trace, stage)) return ok("fact_reaches");
    return no("fact_reaches", `${formatFactTrace(trace, (spec.requiredBy ?? []).length > 0)} — wanted ${stage}`);
  }

  if (assertion.score_at_least !== undefined) {
    if (!scenario.milestones?.length) {
      return no("score_at_least", "the scenario declares no milestones, so there is no score to compare");
    }
    const results = await scoreMilestones(scenario, outcome, opts);
    const { earned, possible, fraction } = milestoneScore(results);
    if (fraction >= assertion.score_at_least) return ok("score_at_least");
    // The last one reached, then the first one missed — the two facts that say
    // where the run stopped. A list of every miss is the same information sorted
    // so the useful part is at the bottom.
    const lastReached = [...results].reverse().find((m) => m.reached);
    const firstMissed = results.find((m) => !m.reached);
    const where = [
      lastReached ? `got as far as ${lastReached.id}` : "reached no milestone",
      firstMissed ? `stopped at ${firstMissed.id} (${firstMissed.detail ?? "not reached"})` : "",
    ]
      .filter(Boolean)
      .join("; ");
    return no(
      "score_at_least",
      `scored ${earned}/${possible} = ${(fraction * 100).toFixed(0)}%, wanted ≥${(assertion.score_at_least * 100).toFixed(0)}% — ${where}`,
    );
  }

  if (assertion.sim_metric !== undefined) {
    const { metric, at_least, at_most } = assertion.sim_metric;
    if (!outcome.simulation) return skip("sim_metric", "this run recorded no simulation");
    const value = outcome.simulation.metrics[metric];
    if (value === undefined) {
      return no(
        "sim_metric",
        `no metric "${metric}" — the simulation reports [${Object.keys(outcome.simulation.metrics).join(", ")}]`,
      );
    }
    const context = `${metric} was ${formatNumber(value)} after ${outcome.simulation.daysManaged} managed of ${outcome.simulation.days} days`;
    if (at_least !== undefined && value < at_least)
      return no("sim_metric", `${context}, wanted ≥${formatNumber(at_least)}`);
    if (at_most !== undefined && value > at_most)
      return no("sim_metric", `${context}, wanted ≤${formatNumber(at_most)}`);
    return ok("sim_metric");
  }

  if (assertion.beats_baseline !== undefined) {
    const { policy, metric = "enterpriseValue", by = 0 } = assertion.beats_baseline;
    if (!outcome.simulation) return skip("beats_baseline", "this run recorded no simulation");
    const sim = outcome.simulation;
    const factory = simulationPolicies(sim.name)[policy];
    if (!factory) {
      return no(
        "beats_baseline",
        `no baseline policy "${policy}" for simulation "${sim.name}" — known: [${Object.keys(simulationPolicies(sim.name)).join(", ")}]`,
      );
    }
    // Re-run on the run's own seed, horizon *and options*, so the comparison is
    // against identical weather rather than against a number remembered from a
    // sweep on a different build of the economy. Costs a few milliseconds and
    // no model.
    //
    // The options matter as much as the seed: `the-endless-descent` starts its
    // party on floor 31, and a baseline replayed without that starts on floor 1
    // and plays a different game entirely. The same omission has now been found
    // and fixed in three separate replay sites.
    const baseline =
      runPolicy(sim.name, factory(), sim.seed, sim.days, sim.daysPerRound ?? 1, sim.options ?? {})[metric] ?? 0;
    const mine = sim.metrics[metric] ?? 0;
    if (mine >= baseline + by) return ok("beats_baseline");
    return no(
      "beats_baseline",
      `${metric} ${formatNumber(mine)} against the ${policy} policy's ${formatNumber(baseline)} on the same seed` +
        `${by ? ` (needed to beat it by ${formatNumber(by)})` : ""}`,
    );
  }

  if (assertion.responds_within !== undefined) {
    const { event, days, crossingRoles } = assertion.responds_within;
    if (!outcome.simulation) return skip("responds_within", "this run recorded no simulation");
    if (!outcome.executions) return skip("responds_within", "this run recorded no executions");
    const sim = outcome.simulation;
    const rows = traceResponses({
      events: sim.events,
      responses: sim.responses ?? {},
      executions: outcome.executions,
      dayOfTurn: sim.dayOfTurn,
      roles: sim.roles,
    }).filter((r) => r.kind === event);
    // An event that never happened on this seed cannot be answered late. Skipped
    // rather than passed, because a green check for "the disruption we did not
    // have was handled promptly" is exactly the kind of free pass that makes a
    // benchmark drift upward without anything improving.
    if (!rows.length) return skip("responds_within", `no "${event}" happened on this seed`);
    // With `crossingRoles`, the clock runs to the first response from *outside*
    // the function that could see the event. Timing the in-function reaction and
    // separately demanding that somebody else also acted would let a team pass
    // by reacting instantly itself and telling the rest of the company a month
    // later.
    const lateness = (r: (typeof rows)[number]) => (crossingRoles ? r.routedLatencyDays : (r.latencyDays ?? undefined));
    const late = rows.filter((r) => lateness(r) === undefined || (lateness(r) as number) > days);
    const wrongHands = crossingRoles ? rows.filter((r) => r.crossedRoles !== true) : [];
    if (!late.length && !wrongHands.length) return ok("responds_within");
    return no(
      "responds_within",
      [
        late.length ? `${late.length}/${rows.length} not answered within ${days} days` : "",
        wrongHands.length ? `${wrongHands.length}/${rows.length} answered only inside the function that saw it` : "",
        formatResponses(rows).trim(),
      ]
        .filter(Boolean)
        .join(" — "),
    );
  }

  if (assertion.judge !== undefined) {
    if (!opts.judge) return { kind: "judge", pass: true, skipped: true };
    const verdict = await opts.judge(assertion.judge.rubric, reply);
    return verdict.pass ? ok("judge") : no("judge", verdict.reason);
  }

  return no("unknown", `no grader for ${JSON.stringify(assertion)}`);
}

function matchesArg(actual: unknown, expected: string | number | boolean): boolean {
  if (typeof expected === "string" && expected.startsWith("/") && expected.lastIndexOf("/") > 0) {
    const end = expected.lastIndexOf("/");
    const re = new RegExp(expected.slice(1, end), expected.slice(end + 1) || "i");
    return re.test(String(actual ?? ""));
  }
  if (typeof actual === "string" && typeof expected === "string") {
    return actual.toLowerCase() === expected.toLowerCase();
  }
  return actual === expected;
}

function lastAssistant(scenario: Scenario): string | undefined {
  const assistants = (scenario.history ?? []).filter((h) => h.role === "assistant");
  return assistants.length ? assistants[assistants.length - 1].content : undefined;
}

function describeRooms(outcome: RunOutcome): string {
  const rooms = [...new Set(outcome.posts.map((p) => p.room))];
  return rooms.length ? rooms.join(", ") : "nowhere";
}

/** Who actually spoke, with counts — the useful half of a `posts_by` failure. */
function describeSpeakers(outcome: RunOutcome): string {
  const counts = new Map<string, number>();
  for (const post of outcome.posts) counts.set(post.agent ?? "?", (counts.get(post.agent ?? "?") ?? 0) + 1);
  if (!counts.size) return "nobody posted";
  return [...counts].map(([agent, n]) => `${agent}×${n}`).join(", ");
}

function trim(text: string, limit = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}
