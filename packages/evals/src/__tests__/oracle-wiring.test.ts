/**
 * Does the `answer` tool actually reach the agent, and do its calls reach the
 * oracle?
 *
 * `oracle.test.ts` covers the `Oracle` class and the grader, both in isolation.
 * Neither says anything about the wiring in between — that the tool is injected
 * into the list core builds, that an allowlist still governs it, that a call
 * lands in the right oracle, and that `guesses` survives the trip out to
 * `RunOutcome`. Every one of those is a place a seam can be silently absent, and
 * a silently absent seam looks exactly like a model that chose not to use the
 * tool.
 *
 * That distinction has already cost this package a wrong conclusion twice: a
 * `toolResults` stub for a tool the agent could not reach made a scenario
 * impossible and it failed looking like a model limit, and a world rule on a
 * tool nobody held did the same. Both are now schema errors. This is the same
 * class of bug one layer down, where the schema cannot see it.
 *
 * The model is a scripted HTTP endpoint rather than a real one. That is the
 * whole point: it makes the test about the plumbing, deterministic, and
 * runnable with no GPU — which is how it came to be written, with vLLM down and
 * the wiring unverified.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HarnessOptions, runOnce } from "../harness.js";
import { substituteTokens } from "../tokens.js";
import type { Scenario } from "../types.js";

/** One scripted turn: what the model "decides" on call N. */
type Turn = { toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>; content?: string };

let server: Server;
let baseUrl: string;
let seen: Array<{ tools: string[] }> = [];
let script: Turn[] = [];

/**
 * An OpenAI-compatible endpoint that replies from `script`, one entry per call.
 *
 * Also records the tool list it was offered, which is the only way to check the
 * *first* thing that has to be true: that `answer` is in front of the model at
 * all. A run where it never appears and a run where the model ignored it are
 * indistinguishable from the outcome alone.
 */
beforeEach(async () => {
  seen = [];
  script = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as { tools?: Array<{ function?: { name?: string } }> };
      seen.push({ tools: (parsed.tools ?? []).map((t) => t.function?.name ?? "?") });
      const turn = script[seen.length - 1] ?? { content: "Done." };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: turn.content ?? null,
                tool_calls: turn.toolCalls?.map((c, i) => ({
                  id: `call-${seen.length}-${i}`,
                  type: "function",
                  function: { name: c.name, arguments: JSON.stringify(c.arguments) },
                })),
              },
              finish_reason: turn.toolCalls?.length ? "tool_calls" : "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function options(): HarnessOptions {
  return {
    baseUrl,
    model: "scripted",
    apiKey: "unused",
    temperature: 0,
    maxTokens: 256,
    maxToolRounds: 4,
    providerExtra: {},
    seed: 1,
    timeoutMs: 15_000,
    pinnedAt: null,
  };
}

function scenario(over: Partial<Scenario> = {}): Scenario {
  return {
    id: "wiring",
    category: "test",
    intent: "wiring",
    difficulty: 1,
    agent: { name: "nova", instructions: "You are Nova.", tools: ["answer"] },
    oracle: { answer: "k7m2xqvz", attempts: 3 },
    message: "what is the code?",
    expect: [{ answers_correctly: true }],
    ...over,
  } as Scenario;
}

describe("the answer tool, end to end", () => {
  it("is offered to the model", async () => {
    script = [{ content: "I have no idea." }];
    await runOnce(scenario(), options());

    // The first thing that has to be true, and the one an outcome cannot show:
    // a tool that never reached the request looks identical to a tool the model
    // declined to use.
    expect(seen[0].tools).toContain("answer");
  });

  it("records a correct submission and carries it out to the outcome", async () => {
    script = [{ toolCalls: [{ name: "answer", arguments: { answer: "k7m2xqvz" } }] }, { content: "That was it." }];
    const outcome = await runOnce(scenario(), options());

    expect(outcome.guesses).toEqual([{ agent: "nova", answer: "k7m2xqvz", correct: true, conceded: false }]);
  });

  it("keeps the whole sequence when the agent guesses its way there", async () => {
    // The sequence is the finding this seam exists to produce, so it has to
    // survive the trip out of the run — not just exist inside the Oracle.
    script = [
      { toolCalls: [{ name: "answer", arguments: { answer: "wrong-one" } }] },
      { toolCalls: [{ name: "answer", arguments: { answer: "wrong-two" } }] },
      { toolCalls: [{ name: "answer", arguments: { answer: "k7m2xqvz" } }] },
      { content: "Got there." },
    ];
    const outcome = await runOnce(scenario(), options());

    expect(outcome.guesses?.map((g) => [g.answer, g.correct])).toEqual([
      ["wrong-one", false],
      ["wrong-two", false],
      ["k7m2xqvz", true],
    ]);
  });

  it("tells the model how many attempts are left", async () => {
    // The refusal text is the only feedback the agent gets, so it has to be the
    // oracle's and not a generic stub result. A tool that fell through to
    // `DEFAULT_STUB_RESULT` would still record a call and still look wired.
    script = [{ toolCalls: [{ name: "answer", arguments: { answer: "nope" } }] }, { content: "ok" }];
    const outcome = await runOnce(scenario(), options());

    const toolReply = outcome.requests[1].messages.map((m) => m.content).join("\n");
    expect(toolReply).toContain("Not correct. 2 attempts remaining.");
  });

  it("stops accepting after the limit, inside a real loop", async () => {
    script = [
      { toolCalls: [{ name: "answer", arguments: { answer: "a" } }] },
      { toolCalls: [{ name: "answer", arguments: { answer: "b" } }] },
      { toolCalls: [{ name: "answer", arguments: { answer: "k7m2xqvz" } }] },
      { content: "done" },
    ];
    const outcome = await runOnce(scenario({ oracle: { answer: "k7m2xqvz", attempts: 2 } }), options());

    // The third call happened and was refused: two recorded, not solved. An
    // off-by-one here would hand a small answer space away for free.
    expect(outcome.guesses).toHaveLength(2);
    expect(outcome.guesses?.some((g) => g.correct)).toBe(false);
  });

  it("accepts a concession only when the scenario allows one", async () => {
    script = [{ toolCalls: [{ name: "answer", arguments: { answer: "unknown" } }] }, { content: "ok" }];

    const strict = await runOnce(scenario(), options());
    expect(strict.guesses?.[0].correct).toBe(false);

    seen = [];
    script = [{ toolCalls: [{ name: "answer", arguments: { answer: "unknown" } }] }, { content: "ok" }];
    const lenient = await runOnce(
      scenario({ oracle: { answer: "k7m2xqvz", attempts: 3, acceptsUnknown: true } }),
      options(),
    );
    expect(lenient.guesses?.[0]).toMatchObject({ correct: true, conceded: true });
  });

  it("is absent when the scenario declares no oracle", async () => {
    // Otherwise every scenario in the set silently grows a tool, which changes
    // the tool-selection pressure each one is measuring.
    script = [{ content: "hello" }];
    const outcome = await runOnce(
      scenario({ oracle: undefined, agent: { name: "nova", tools: ["exec"] }, expect: [{ replies: true }] }),
      options(),
    );

    expect(seen[0].tools).not.toContain("answer");
    expect(outcome.guesses).toBeUndefined();
  });

  it("is handed the run's witness value, not the literal token", async () => {
    // The failure this rules out is silent and total: an oracle whose accepted
    // answer is still the string `{{token:window}}` can never be satisfied, so
    // the scenario scores 0 every run and reads as a capability the model does
    // not have. Substitution happens in the worker, one layer above `runOnce`,
    // which is exactly the kind of gap between two correct pieces that this
    // file exists for. The same mistake in the other direction — minting inside
    // `runOnce` — already shipped once and broke every witness assertion.
    const minted = substituteTokens(
      scenario({ tokens: { window: "time" }, oracle: { answer: "{{token:window}}", attempts: 3 } }),
      { window: "14:30" },
    );

    script = [{ toolCalls: [{ name: "answer", arguments: { answer: "14:30" } }] }, { content: "ok" }];
    const outcome = await runOnce(minted, options());

    expect(outcome.guesses?.[0].correct).toBe(true);
  });

  it("stays behind the agent's allowlist", async () => {
    // An oracle is not a licence to bypass `tools:`. A scenario that gives the
    // agent a tool it did not ask for is measuring a different agent.
    script = [{ content: "hello" }];
    await runOnce(scenario({ agent: { name: "nova", tools: ["exec"] }, expect: [{ replies: true }] }), options());

    expect(seen[0].tools).not.toContain("answer");
  });
});
