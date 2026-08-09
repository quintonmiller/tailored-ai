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
import { describeRequest, retryDelayMs, turnFailed } from "../harness.js";
import { score } from "../report.js";
import type { Assertion, BenchmarkReport, RunOutcome, Scenario } from "../types.js";

function outcome(over: Partial<RunOutcome> = {}): RunOutcome {
  return {
    reply: "",
    calls: [],
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

  it("warns when the two runs are not comparable", () => {
    const { warnings } = compareReports(
      report({}, { a: 1 }),
      report({ scenarioSetHash: "other", model: "n" }, { a: 1 }),
    );
    expect(warnings.join(" ")).toMatch(/scenario sets differ/);
    expect(warnings.join(" ")).toMatch(/different models/);
  });

  it("reports scenarios that only exist on one side rather than scoring them", () => {
    const { rows, added, removed } = compareReports(report({}, { a: 1, gone: 1 }), report({}, { a: 1, fresh: 1 }));
    expect(rows.map((r) => r.id)).toEqual(["a"]);
    expect(added).toEqual(["fresh"]);
    expect(removed).toEqual(["gone"]);
  });
});
