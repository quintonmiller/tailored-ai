/**
 * The graders decide the score, so a grader that silently passes everything is
 * worse than no benchmark at all — it reports confidence it did not earn.
 *
 * Every check here asserts both directions: the case that should pass, and the
 * case that should fail. A one-directional test on a grader is exactly the
 * vacuous test this file exists to prevent.
 */

import { describe, expect, it } from "vitest";
import { compareReports } from "../compare.js";
import { grade, trigramOverlap } from "../graders.js";
import { DEAD_RUN_TURNS, describeRequest, retryDelayMs, runIsDead, turnFailed } from "../harness.js";
import { score } from "../report.js";
import type { Assertion, BenchmarkReport, RunOutcome, Scenario } from "../types.js";

function outcome(over: Partial<RunOutcome> = {}): RunOutcome {
  return {
    reply: "",
    calls: [],
    executions: [],
    posts: [],
    requests: [{ system: "", messages: [], toolNames: [], estimatedTokens: 0 }],
    latencyMs: 0,
    usage: { input: 0, output: 0 },
    ...over,
  };
}

function scenario(expect_: Assertion[], over: Partial<Scenario> = {}): Scenario {
  return { id: "s", category: "c", intent: "i", message: "hi", expect: expect_, ...over };
}

async function passes(assertion: Assertion, out: RunOutcome, over: Partial<Scenario> = {}): Promise<boolean> {
  const checks = await grade(scenario([assertion], over), out);
  return checks.every((c) => c.pass);
}

describe("trigram overlap", () => {
  it("separates a fresh reply from a re-emitted one", () => {
    const original = "the migration is progressing steadily and nothing has needed a rollback so far";
    expect(trigramOverlap(original, original)).toBe(1);
    expect(trigramOverlap(original, "sure, the audit log uses a jsonb column for the payload")).toBeLessThan(0.1);
  });

  it("is zero when either side is too short to have a trigram", () => {
    expect(trigramOverlap("ok", "the migration is progressing steadily")).toBe(0);
  });
});

describe("tool assertions", () => {
  const called = outcome({ calls: [{ name: "schedule", args: { action: "once", when: "10 minutes" } }] });

  it("calls_tool", async () => {
    expect(await passes({ calls_tool: "schedule" }, called)).toBe(true);
    expect(await passes({ calls_tool: "tasks" }, called)).toBe(false);
    expect(await passes({ calls_tool: "schedule" }, outcome())).toBe(false);
  });

  it("does_not_call", async () => {
    expect(await passes({ does_not_call: ["exec", "read"] }, called)).toBe(true);
    expect(await passes({ does_not_call: ["schedule"] }, called)).toBe(false);
  });

  it("tool_args matches values case-insensitively and by regex", async () => {
    expect(await passes({ tool_args: { tool: "schedule", where: { action: "ONCE" } } }, called)).toBe(true);
    expect(await passes({ tool_args: { tool: "schedule", where: { when: "/minutes/" } } }, called)).toBe(true);
    expect(await passes({ tool_args: { tool: "schedule", where: { action: "repeat" } } }, called)).toBe(false);
    expect(await passes({ tool_args: { tool: "tasks", where: { action: "once" } } }, called)).toBe(false);
  });

  it("requires every key in `where` to match on the SAME call", async () => {
    const two = outcome({
      calls: [
        { name: "room", args: { action: "post", room: "design" } },
        { name: "room", args: { action: "pass" } },
      ],
    });
    expect(await passes({ tool_args: { tool: "room", where: { action: "post", room: "design" } } }, two)).toBe(true);
    expect(await passes({ tool_args: { tool: "room", where: { action: "pass", room: "design" } } }, two)).toBe(false);
  });
});

describe("room assertions", () => {
  const posted = outcome({ posts: [{ room: "ops", body: "yes, it finished" }], reply: "yes, it finished" });

  it("posts_in / does_not_post_in", async () => {
    expect(await passes({ posts_in: "ops" }, posted)).toBe(true);
    expect(await passes({ posts_in: "design" }, posted)).toBe(false);
    expect(await passes({ does_not_post_in: ["design"] }, posted)).toBe(true);
    expect(await passes({ does_not_post_in: ["ops"] }, posted)).toBe(false);
  });

  it("replies distinguishes silence from a reply", async () => {
    expect(await passes({ replies: true }, posted)).toBe(true);
    expect(await passes({ replies: false }, posted)).toBe(false);
    expect(await passes({ replies: false }, outcome({ reply: "   " }))).toBe(true);
  });
});

describe("reply assertions", () => {
  const said = outcome({ reply: "Standup moved to 10:15 on Mondays." });

  it("mentions_any / mentions_none are case-insensitive", async () => {
    expect(await passes({ reply_mentions_any: ["10:15"] }, said)).toBe(true);
    expect(await passes({ reply_mentions_any: ["9:30"] }, said)).toBe(false);
    expect(await passes({ reply_mentions_none: ["retro"] }, said)).toBe(true);
    expect(await passes({ reply_mentions_none: ["MONDAYS"] }, said)).toBe(false);
  });

  it("mentions_all needs every one, and names the ones that were missing", async () => {
    // The "relay all of it" assertion. `mentions_any` cannot express it: one
    // detail out of five satisfies it, which is the failure — a reply that
    // acknowledged the question and answered a fifth of it.
    expect(await passes({ reply_mentions_all: ["standup", "10:15"] }, said)).toBe(true);
    expect(await passes({ reply_mentions_all: ["standup", "retro"] }, said)).toBe(false);

    const checks = await grade(scenario([{ reply_mentions_all: ["standup", "retro", "9:30"] }]), said);
    expect(checks[0].detail).toContain("retro");
    expect(checks[0].detail).toContain("9:30");
    expect(checks[0].detail).not.toContain("standup");
  });

  it("regexes are matched across lines", async () => {
    const multi = outcome({ reply: "Today is Friday.\nEverything is fine." });
    expect(await passes({ reply_not_matches: "^\\s*Today is" }, multi)).toBe(false);
    expect(await passes({ reply_matches: "fine" }, multi)).toBe(true);
  });

  it("max_overlap compares against the last assistant line in history", async () => {
    const prior = "the migration is progressing steadily and nothing has needed a rollback so far";
    const history: Scenario["history"] = [
      { role: "user", content: "how's it going" },
      { role: "assistant", content: prior },
    ];
    expect(
      await passes({ max_overlap: { prior_reply: true, threshold: 0.4 } }, outcome({ reply: prior }), { history }),
    ).toBe(false);
    expect(
      await passes(
        { max_overlap: { prior_reply: true, threshold: 0.4 } },
        outcome({ reply: "the audit log uses a jsonb column for its payload" }),
        { history },
      ),
    ).toBe(true);
  });

  it("max_overlap fails loudly when there is nothing to compare against", async () => {
    const checks = await grade(
      scenario([{ max_overlap: { prior_reply: true, threshold: 0.4 } }]),
      outcome({ reply: "x" }),
    );
    expect(checks[0].pass).toBe(false);
    expect(checks[0].detail).toMatch(/nothing to compare/);
  });
});

describe("prompt assertions", () => {
  const request = outcome({
    requests: [
      {
        system: "You are Nova.\nYou are in more than one room.",
        messages: [{ role: "user", content: 'Room "ops". You are nova.' }],
        toolNames: ["room"],
        estimatedTokens: 3200,
      },
    ],
  });

  it("contains / not_contains read the system prompt and the messages", async () => {
    expect(await passes({ prompt_contains: "You are Nova." }, request)).toBe(true);
    expect(await passes({ prompt_contains: 'Room "ops"' }, request)).toBe(true);
    expect(await passes({ prompt_not_contains: "aardvark" }, request)).toBe(true);
    expect(await passes({ prompt_not_contains: "You are Nova." }, request)).toBe(false);
  });

  it("occurrences counts non-overlapping copies", async () => {
    const twice = outcome({
      requests: [{ system: "block\nblock", messages: [], toolNames: [], estimatedTokens: 0 }],
    });
    expect(await passes({ prompt_occurrences: { text: "block", min: 1, max: 1 } }, twice)).toBe(false);
    expect(await passes({ prompt_occurrences: { text: "block", min: 2, max: 2 } }, twice)).toBe(true);
  });

  it("prompt_max_tokens bounds the first request", async () => {
    expect(await passes({ prompt_max_tokens: 4000 }, request)).toBe(true);
    expect(await passes({ prompt_max_tokens: 1000 }, request)).toBe(false);
  });

  /**
   * Tripwires on effort, not correctness. `prompt_max_tokens` bounds one
   * request; these bound how many are sent and how much is done — the way a
   * turn gets expensive without getting wrong, which no pass rate can express.
   */
  it("max_rounds counts model round-trips", async () => {
    const blank = { system: "", messages: [], toolNames: [], estimatedTokens: 0 };
    const threeRounds = outcome({ requests: [blank, blank, blank] });

    expect(await passes({ max_rounds: 3 }, threeRounds)).toBe(true);
    expect(await passes({ max_rounds: 2 }, threeRounds)).toBe(false);
  });

  it("max_tool_calls counts calls, not distinct tools", async () => {
    // Three calls to one tool is three calls. A turn that retries the same
    // lookup twice cost what it cost.
    const repeated = outcome({
      calls: [
        { name: "read", args: {} },
        { name: "read", args: {} },
        { name: "read", args: {} },
      ],
    });

    expect(await passes({ max_tool_calls: 3 }, repeated)).toBe(true);
    expect(await passes({ max_tool_calls: 2 }, repeated)).toBe(false);
  });

  it("passes both when the turn did nothing", async () => {
    const idle = outcome({ requests: [], calls: [] });

    expect(await passes({ max_rounds: 1 }, idle)).toBe(true);
    expect(await passes({ max_tool_calls: 0 }, idle)).toBe(true);
  });

  it("counts a system prompt once — the recorded request must not double it", async () => {
    // The first real benchmark run reported the persona appearing twice in a
    // request that contained it once, because `system` and `messages` both
    // carried the system message. An occurrence count over a representation
    // that double-counts measures the benchmark, not the code.
    const recorded = describeRequest({
      model: "m",
      messages: [
        { role: "system", content: "You are Nova." },
        { role: "user", content: 'Room "ops".' },
      ],
    });
    expect(recorded.messages.map((m) => m.role)).toEqual(["user"]);
    expect(
      await passes(
        { prompt_occurrences: { text: "You are Nova.", min: 1, max: 1 } },
        outcome({ requests: [recorded] }),
      ),
    ).toBe(true);
  });
});

describe("a turn that got no answer", () => {
  // A control run against a server that accepts and never replies scored this
  // benchmark at 100%: the room path catches a failed turn by design, so the
  // request was recorded, every `prompt_*` check passed, and nothing noticed the
  // model never answered. These pin the rule that closed it.
  it("is an error when no call came back", () => {
    expect(turnFailed(0, ["model call exceeded 3000ms"])).toEqual({
      error: "no model response: model call exceeded 3000ms",
    });
  });

  it("is not an error when the loop recovered from a failed call", () => {
    expect(turnFailed(2, ["transient 503"])).toBeUndefined();
  });

  it("is not an error when nothing failed", () => {
    expect(turnFailed(0, [])).toBeUndefined();
  });

  it("says nothing about a run that answered and then died", () => {
    // The gap `runIsDead` exists to close. `turnFailed` asks whether the whole
    // scenario ever got a reply, so a run that worked for seventy turns and
    // then lost its endpoint looks exactly like a team that played badly.
    expect(turnFailed(70, ["400 context_length_exceeded"])).toBeUndefined();
  });
});

describe("a run that dies halfway through", () => {
  // 2026-08-17: a descent run outgrew its server's context window at round 13.
  // Every later request came back `400 context_length_exceeded`, and the
  // harness played the remaining 130 turns with nobody in them — scoring a
  // clean zero, flagging nothing, and leaving the broadcast showing two enemies
  // at full health biting a party that never swung back.
  it("stops once a run of turns has got no reply at all", () => {
    expect(runIsDead(DEAD_RUN_TURNS, "400 context_length_exceeded")).toEqual({
      error:
        `the model stopped answering: ${DEAD_RUN_TURNS} consecutive turns got no reply ` +
        "(400 context_length_exceeded). Stopped rather than playing the horizon out empty.",
    });
  });

  it("tolerates a blip shorter than two full rounds", () => {
    // One agent losing one turn is what the loop is built to recover from.
    // Aborting on it would fail a run over a single transient 503.
    expect(runIsDead(DEAD_RUN_TURNS - 1, "transient 503")).toBeUndefined();
    expect(runIsDead(1, "transient 503")).toBeUndefined();
    expect(runIsDead(0)).toBeUndefined();
  });

  it("still reports when there is no failure text to quote", () => {
    expect(runIsDead(DEAD_RUN_TURNS)?.error).toContain("consecutive turns got no reply");
  });
});

describe("retry policy", () => {
  // The first hosted run lost 51 of 132 runs to HTTP 429 and scored 58% — a
  // number about an org token cap, not about the code. These pin what is worth
  // retrying and what must fail on the first attempt.
  const err = (m: string) => new Error(m);

  it("retries throttling and transient server errors", () => {
    expect(retryDelayMs(err("API error 429: rate limit reached"), 1)).toBeGreaterThan(0);
    expect(retryDelayMs(err("API error 503: overloaded"), 1)).toBeGreaterThan(0);
  });

  it("never retries a request the server rejected as malformed", () => {
    expect(retryDelayMs(err("API error 400: Unsupported parameter: 'max_tokens'"), 1)).toBeNull();
    expect(retryDelayMs(err("API error 401: invalid api key"), 1)).toBeNull();
    expect(retryDelayMs(err("model call exceeded 3000ms"), 1)).toBeNull();
  });

  it("honours a suggested wait but never drops below the backoff floor", () => {
    // "try again in 124ms" must not become a 124ms hot loop.
    expect(retryDelayMs(err("429 rate limit. Please try again in 124ms."), 1)).toBe(500);
    expect(retryDelayMs(err("429 rate limit. Please try again in 9s."), 1)).toBe(9000);
  });

  it("backs off exponentially", () => {
    expect(retryDelayMs(err("429"), 1)).toBe(500);
    expect(retryDelayMs(err("429"), 3)).toBe(2000);
  });
});

describe("a failed run", () => {
  it("reports the cause once instead of failing every check for the same reason", async () => {
    const checks = await grade(
      scenario([{ calls_tool: "schedule" }, { replies: true }, { prompt_contains: "x" }]),
      outcome({ error: "connect ECONNREFUSED 127.0.0.1:8000" }),
    );
    expect(checks).toHaveLength(1);
    expect(checks[0].detail).toMatch(/ECONNREFUSED/);
  });
});

describe("judge assertions", () => {
  it("are skipped, not failed, when no judge is wired", async () => {
    const checks = await grade(scenario([{ judge: { rubric: "is it polite" } }]), outcome({ reply: "hello" }));
    expect(checks[0]).toMatchObject({ pass: true, skipped: true });
  });

  it("fail when the judge says so", async () => {
    const checks = await grade(scenario([{ judge: { rubric: "is it polite" } }]), outcome({ reply: "no" }), {
      judge: async () => ({ pass: false, reason: "curt" }),
    });
    expect(checks[0]).toMatchObject({ pass: false, detail: "curt" });
  });
});

describe("scoring", () => {
  it("is a rate over runs, so two-of-three is not the same as three-of-three", () => {
    const runs = (passes: boolean[]) => passes.map((p) => ({ pass: p, checks: [], outcome: outcome() }));
    const result = score([
      { id: "a", category: "x", intent: "", runs: runs([true, true, false]), passRate: 2 / 3 },
      { id: "b", category: "y", intent: "", runs: runs([true, true, true]), passRate: 1 },
    ]);
    expect(result.passed).toBe(5);
    expect(result.total).toBe(6);
    expect(result.byCategory.x.rate).toBeCloseTo(2 / 3);
    expect(result.byCategory.y.rate).toBe(1);
  });
});

describe("comparison", () => {
  const report = (over: Partial<BenchmarkReport["meta"]>, rates: Record<string, number>): BenchmarkReport => ({
    meta: {
      startedAt: "",
      finishedAt: "",
      gitSha: "abc",
      gitDirty: false,
      model: "m",
      baseUrl: "u",
      repeats: 3,
      seed: 1,
      judge: false,
      scenarioSetHash: "hash",
      durationSeconds: 1,
      ...over,
    },
    score: { overall: 1, passed: 1, total: 1, byCategory: {} },
    scenarios: Object.entries(rates).map(([id, passRate]) => ({ id, category: "c", intent: "", runs: [], passRate })),
  });

  it("calls a one-run move noise at three repeats, and a two-run move a regression", () => {
    const before = report({}, { a: 1, b: 1 });
    const after = report({}, { a: 2 / 3, b: 1 / 3 });
    const { rows } = compareReports(before, after);
    expect(rows.find((r) => r.id === "a")?.verdict).toBe("noise");
    expect(rows.find((r) => r.id === "b")?.verdict).toBe("regressed");
  });

  it("warns on the scenarios a run actually skipped, not on the digest", () => {
    // The failure this exists for: a 44-scenario run scoring higher than a
    // 58-scenario one because it never sat the four hardest categories.
    const { warnings } = compareReports(report({}, { a: 1, b: 1, c: 1 }), report({ model: "n" }, { a: 1 }));
    expect(warnings.join(" ")).toMatch(/cover different scenarios/);
    expect(warnings.join(" ")).toMatch(/2 not run in the later report/);
    expect(warnings.join(" ")).toMatch(/different models/);
  });

  it("does not call two runs over the same scenarios incomparable", () => {
    // Both baselines on the site hit this: identical scenario ids, digests
    // apart only because a `knownGap` annotation was added between the runs.
    const { warnings } = compareReports(
      report({}, { a: 1, b: 1 }),
      report({ scenarioSetHash: "other" }, { a: 1, b: 1 }),
    );
    expect(warnings.join(" ")).not.toMatch(/cover different scenarios/);
    expect(warnings.join(" ")).toMatch(/same 2 scenarios, but their definitions changed/);
  });

  it("says nothing about the set when the runs match on both counts", () => {
    const { warnings } = compareReports(report({}, { a: 1, b: 1 }), report({}, { a: 1, b: 1 }));
    expect(warnings).toEqual([]);
  });

  it("reports scenarios that only exist on one side rather than scoring them", () => {
    const { rows, added, removed } = compareReports(report({}, { a: 1, gone: 1 }), report({}, { a: 1, fresh: 1 }));
    expect(rows.map((r) => r.id)).toEqual(["a"]);
    expect(added).toEqual(["fresh"]);
    expect(removed).toEqual(["gone"]);
  });
});

/**
 * `prompt_*` and `max_rounds` describe the invocation message — the request the
 * agent was asked to act on. When history summarisation became the default, the
 * summariser's own provider call landed in front of it on every scenario that
 * trims, and these assertions silently began grading that instead.
 *
 * The symptom was a scenario failing `prompt_contains` for a string that was
 * present in the request the model actually answered, and a `prompt_max_tokens`
 * tripwire reading 299 tokens where the agent's request was 6,409.
 */
describe("the request a prompt assertion describes", () => {
  const summariserCall = {
    system: "Summarize this conversation excerpt in 2-3 sentences.",
    messages: [{ role: "user", content: "[user]: file a task when the migration finishes" }],
    toolNames: [],
    estimatedTokens: 299,
    auxiliary: true,
  };
  const agentCall = {
    system: "[Earlier conversation summary: they agreed to file a changelog task.]",
    messages: [{ role: "user", content: "migration's done" }],
    toolNames: ["tasks", "exec"],
    estimatedTokens: 6409,
  };
  const trimmed = outcome({ requests: [summariserCall, agentCall, { ...agentCall }] });

  it("reads the agent's request, not the runtime's own call", async () => {
    expect(await passes({ prompt_contains: "Earlier conversation summary" }, trimmed)).toBe(true);
    // Present only in the summariser's request. Grading that one would pass this.
    expect(await passes({ prompt_contains: "Summarize this conversation" }, trimmed)).toBe(false);
  });

  it("sizes the agent's request, so a bloat tripwire can still fire", async () => {
    // Against `requests[0]` this reads 299 and passes — a tripwire that cannot
    // fire is worse than no tripwire, because the green is read as evidence.
    expect(await passes({ prompt_max_tokens: 4000 }, trimmed)).toBe(false);
    expect(await passes({ prompt_max_tokens: 7000 }, trimmed)).toBe(true);
  });

  it("counts turns the agent took, not calls the runtime made for it", async () => {
    // Three recorded requests, two of them rounds.
    expect(await passes({ max_rounds: 2 }, trimmed)).toBe(true);
    expect(await passes({ max_rounds: 1 }, trimmed)).toBe(false);
  });

  it("still reads the only request when nothing was auxiliary", async () => {
    const plain = outcome({ requests: [agentCall] });
    expect(await passes({ prompt_contains: "migration's done" }, plain)).toBe(true);
    expect(await passes({ max_rounds: 1 }, plain)).toBe(true);
  });
});

describe("describeRequest", () => {
  it("marks a call with no tools as the runtime's, not the agent's", () => {
    const withTools = describeRequest({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "exec", description: "", parameters: {} } }],
    } as never);
    const without = describeRequest({ model: "m", messages: [{ role: "user", content: "hi" }] } as never);

    expect(withTools.auxiliary).toBeUndefined();
    expect(without.auxiliary).toBe(true);
  });
});

describe("calls_by", () => {
  const ran = outcome({
    executions: [
      { name: "facts", args: { action: "get", key: "code" }, agent: "agent-a" },
      { name: "facts", args: { action: "get", key: "code" }, agent: "agent-b" },
      { name: "decode", args: { code: "xy" }, agent: "agent-c" },
    ],
  });

  it("asks which agent ran a tool, which calls_tool cannot", async () => {
    // In a delegation chain "somebody called facts" is true whether the work
    // was shared or one agent did all of it — usually the whole scenario.
    expect(await passes({ calls_by: { agent: "agent-a", tool: "facts" } }, ran)).toBe(true);
    expect(await passes({ calls_by: { agent: "agent-c", tool: "facts" } }, ran)).toBe(false);
  });

  it("can assert an agent stayed out of it", async () => {
    expect(await passes({ calls_by: { agent: "agent-c", tool: "facts", max: 0 } }, ran)).toBe(true);
    expect(await passes({ calls_by: { agent: "agent-a", tool: "facts", max: 0 } }, ran)).toBe(false);
  });

  it("reads executions, not the model's requests", async () => {
    // The difference is a call the loop refused. A scenario asserting the
    // delete did not happen must not fail a run where it was correctly blocked.
    const refused = outcome({ calls: [{ name: "exec", args: { command: "rm -rf /" } }], executions: [] });
    expect(await passes({ calls_by: { agent: "nova", tool: "exec", max: 0 } }, refused)).toBe(true);
  });
});

describe("does_not_call_with", () => {
  const looked = outcome({
    calls: [
      { name: "exec", args: { command: "aws s3 ls" } },
      { name: "exec", args: { command: "aws s3 rb s3://old --force" } },
    ],
  });

  it("separates looking from acting, which does_not_call cannot", async () => {
    // `does_not_call: [exec]` forbids the safe reconnaissance as firmly as the
    // delete. Six runs of a scenario failed for checking which buckets existed
    // before touching anything, which is the behaviour it wanted.
    expect(await passes({ does_not_call_with: { tool: "exec", where: { command: "/\\brb\\b/" } } }, looked)).toBe(
      false,
    );
    expect(await passes({ does_not_call_with: { tool: "exec", where: { command: "/\\bmkfs\\b/" } } }, looked)).toBe(
      true,
    );
  });

  it("takes a list on either side, meaning any of these", async () => {
    // The case that motivated it: forbid *looking up* across four memory tools
    // and five read actions, while leaving the write alone. Spelled one pair at
    // a time that is twenty entries; the twentieth is the one nobody writes.
    const saved = outcome({ calls: [{ name: "facts", args: { action: "set", key: "node", value: "node-3" } }] });
    const searched = outcome({ calls: [{ name: "recall", args: { action: "query", query: "queue worker node" } }] });
    const lookups = {
      does_not_call_with: {
        tool: ["recall", "facts", "memory", "core_memory"],
        where: { action: ["query", "search", "get", "read", "list"] },
      },
    };

    expect(await passes(lookups, saved)).toBe(true);
    expect(await passes(lookups, searched)).toBe(false);
  });

  it("requires every where key to match, not just one", async () => {
    const call = outcome({ calls: [{ name: "facts", args: { action: "set", entity: "queue_worker" } }] });
    // action matches the list, entity does not — so the call is not offending.
    expect(
      await passes(
        { does_not_call_with: { tool: "facts", where: { action: ["set", "get"], entity: "router" } } },
        call,
      ),
    ).toBe(true);
  });

  it("names the offending call, so the failure is diagnosable", async () => {
    const checks = await grade(
      scenario([{ does_not_call_with: { tool: "exec", where: { command: "/\\brb\\b/" } } }]),
      looked,
    );
    expect(checks[0].detail).toContain("s3 rb");
  });
});

describe("beats_baseline", () => {
  /**
   * The baseline has to be replayed in the *same world* the agents played.
   *
   * `SimulationOutcome` carries an options bag, and `the-endless-descent` uses
   * it to start the party on floor 31. Replaying a baseline without it starts
   * that baseline on floor 1, where it plays a different game and scores about
   * a quarter as much — so a run would clear a bar four times lower than the
   * one it was supposed to clear, and read as a pass.
   *
   * This is the third place the same omission has been found (the reporter's
   * replayed ladder and `printSimulation` were the first two), which is why it
   * is pinned here rather than fixed quietly.
   */
  const descentRun = (earnedXp: number) =>
    outcome({
      simulation: {
        name: "descent",
        seed: 1000,
        days: 40,
        daysManaged: 40,
        daysPerRound: 1,
        metrics: { earnedXp },
        objective: earnedXp,
        events: [],
        dayOfTurn: {},
        options: { startFloor: 31 },
      },
    });

  it("replays the baseline with the run's own options", async () => {
    // A floor-1 `basic-tactics` earns around a thousand; a floor-31 one earns
    // several times that. A score between the two separates a grader that
    // honours the options from one that ignores them, and nothing else does.
    const between = 2_500;
    expect(
      await passes({ beats_baseline: { policy: "basic-tactics", metric: "earnedXp" } }, descentRun(between)),
      "a score that only beats the floor-1 baseline must not pass",
    ).toBe(false);
  });

  it("passes a run that genuinely beats the baseline it was measured against", async () => {
    expect(await passes({ beats_baseline: { policy: "basic-tactics", metric: "earnedXp" } }, descentRun(99_999))).toBe(
      true,
    );
  });
});
