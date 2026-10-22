/**
 * How the commentator talks to a server, as opposed to what it says.
 *
 * Every fault below was found the same way on 2026-08-17: a narrator pointed at
 * NInfer started cleanly, printed the sidecar path it was writing, and then
 * produced nothing at all for a whole run. Nothing logged, nothing threw, and
 * the broadcast simply had no commentary panel. A dropped line is deliberately
 * not fatal here — a commentator who loses their line does not stop the match —
 * which is exactly why every way of losing one needs a test.
 *
 * They are transport faults, so they are tested through `narrate()` with a
 * stubbed `fetch` rather than against a live model.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { narrate } from "../narrate.js";
import type { TraceEvent } from "../trace.js";

/** One finished round, which is the least the digest will act on. */
function trace(): string {
  const events: TraceEvent[] = [
    { kind: "round", at: 1, round: 0 } as TraceEvent,
    {
      kind: "state",
      at: 2,
      turn: 0,
      round: 0,
      resolved: true,
      snapshot: {
        scene: { floor: 1, phase: "explore", log: ["The party opens the gate."], enemies: [] },
        party: {},
      },
    } as unknown as TraceEvent,
    { kind: "end", at: 3 } as unknown as TraceEvent,
  ];
  const dir = mkdtempSync(join(tmpdir(), "narrate-"));
  const path = join(dir, "run.ndjson");
  writeFileSync(path, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
  return path;
}

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** What a server that finished normally and answered in `content` returns. */
const spoke = (text: string) => reply({ choices: [{ finish_reason: "stop", message: { content: text } }] });

afterEach(() => vi.unstubAllGlobals());

async function run(fetchImpl: typeof fetch, onNote?: (n: string) => void) {
  vi.stubGlobal("fetch", fetchImpl);
  const tracePath = trace();
  const spokenCount = await narrate({
    tracePath,
    baseUrl: "http://127.0.0.1:8080/v1",
    model: "test-model",
    ...(onNote ? { onNote } : {}),
  });
  const sidecar = tracePath.replace(/\.ndjson$/, ".narration.ndjson");
  let written = "";
  try {
    written = readFileSync(sidecar, "utf8");
  } catch {
    written = "";
  }
  return { spoken: spokenCount, written };
}

describe("the commentator's transport", () => {
  it("falls to `reasoning_effort` when the server rejects chat_template_kwargs", async () => {
    // NInfer answers 400 `chat_template_option_not_supported` rather than
    // ignoring the key, which the code had assumed every server would do. One
    // rejected body, re-sent every two seconds, is a silent narrator.
    //
    // The second rung was added on 2026-08-18 and is the one that matters. The
    // original ladder went straight from "vLLM's words were refused" to "give
    // up and quadruple the budget", and **13 of 30 rounds of a live run still
    // came back empty** — a model handed 2,000 tokens and no instruction to be
    // brief spends them all wondering what the question is. The server was
    // never unable to stop thinking; it was unable to be asked in vLLM's words.
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.chat_template_kwargs) {
        return reply({ error: { code: "chat_template_option_not_supported", param: "chat_template_kwargs" } }, 400);
      }
      return spoke("The party opens the gate.");
    }) as unknown as typeof fetch;

    const notes: string[] = [];
    const { spoken, written } = await run(fetchImpl, (n) => notes.push(n));

    expect(spoken).toBe(1);
    expect(written).toContain("The party opens the gate.");
    expect(bodies).toHaveLength(2);
    expect(bodies[0].chat_template_kwargs).toBeDefined();
    expect(bodies[1].chat_template_kwargs).toBeUndefined();
    expect(bodies[1].reasoning_effort).toBe("none");
    // No complaint, because nothing went wrong: the server took the second way
    // of asking. The old note fired here and told the operator the narrator had
    // given up when it had not.
    expect(notes.join(" ")).not.toMatch(/will not turn thinking down/);
  });

  it("only gives up on the budget when both ways of asking are refused", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.chat_template_kwargs) return reply({ error: { param: "chat_template_kwargs" } }, 400);
      if (body.reasoning_effort) return reply({ error: { param: "reasoning_effort" } }, 400);
      return spoke("A line.");
    }) as unknown as typeof fetch;

    const notes: string[] = [];
    const { spoken } = await run(fetchImpl, (n) => notes.push(n));
    expect(spoken).toBe(1);
    expect(bodies).toHaveLength(3);
    expect(bodies[2].chat_template_kwargs).toBeUndefined();
    expect(bodies[2].reasoning_effort).toBeUndefined();
    expect(bodies[2].max_tokens).toBeGreaterThanOrEqual(1200);
    expect(notes.join(" ")).toMatch(/will not turn thinking down/);
  });

  it("does not keep asking a server that has already refused", async () => {
    // The refusal is learned once. Re-offering the rejected key every round
    // doubles the request count and reintroduces the same 400 forever.
    const events: TraceEvent[] = [];
    for (const n of [0, 1]) {
      events.push({ kind: "round", at: n * 10 + 1, round: n } as TraceEvent);
      events.push({
        kind: "state",
        at: n * 10 + 2,
        turn: n,
        round: n,
        resolved: true,
        snapshot: { scene: { floor: 1, phase: "explore", log: [`Round ${n}.`], enemies: [] }, party: {} },
      } as unknown as TraceEvent);
    }
    events.push({ kind: "end", at: 99 } as unknown as TraceEvent);
    const dir = mkdtempSync(join(tmpdir(), "narrate-"));
    const path = join(dir, "run.ndjson");
    writeFileSync(path, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);

    let offered = 0;
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.chat_template_kwargs) {
        offered += 1;
        return reply({ error: { param: "chat_template_kwargs" } }, 400);
      }
      return spoke("A line.");
    }) as unknown as typeof fetch;

    vi.stubGlobal("fetch", fetchImpl);
    await narrate({ tracePath: path, baseUrl: "http://x/v1", model: "m" });
    expect(offered).toBe(1);
  });

  it("reads the thinking channel under either of its two names", async () => {
    // `reasoning` is OpenAI's name; `reasoning_content` is vLLM's and NInfer's.
    // The fallback read only the first, so against a local server it had never
    // once fired.
    const fetchImpl = vi.fn(async () =>
      reply({ choices: [{ finish_reason: "stop", message: { content: "", reasoning_content: "A quiet round." } }] }),
    ) as unknown as typeof fetch;
    const { spoken, written } = await run(fetchImpl);
    expect(spoken).toBe(1);
    expect(written).toContain("A quiet round.");
  });

  it("falls through an empty string, not just a null", async () => {
    // The fallback was written `content ?? reasoning`. Both local servers return
    // `""` rather than `null`, and `""` is not nullish — so the branch was
    // unreachable on two counts at once.
    const fetchImpl = vi.fn(async () =>
      reply({ choices: [{ finish_reason: "stop", message: { content: "", reasoning: "Said anyway." } }] }),
    ) as unknown as typeof fetch;
    const { spoken } = await run(fetchImpl);
    expect(spoken).toBe(1);
  });

  it("skips a round whose budget went entirely on thinking, rather than printing the scratchpad", async () => {
    // `finish_reason: "length"` with empty content means the trace is cut off
    // mid-thought. What is in there is the model wondering what the question is
    // — "We need answer user's prompt?" — and a viewer cannot tell that from
    // commentary. Silence is the better failure.
    const fetchImpl = vi.fn(async () =>
      reply({
        choices: [
          {
            finish_reason: "length",
            message: { content: "", reasoning_content: "We need answer user's prompt? They provided game state" },
          },
        ],
      }),
    ) as unknown as typeof fetch;
    const notes: string[] = [];
    const { spoken, written } = await run(fetchImpl, (n) => notes.push(n));
    expect(spoken).toBe(0);
    expect(written).toBe("");
    expect(notes.join(" ")).toMatch(/whole budget thinking/);
  });

  it("gives a reason for a silence caused by a failed call", async () => {
    // Any HTTP failure used to return null with nothing logged, so a narrator
    // that could not reach its model looked exactly like a quiet dungeon.
    const fetchImpl = vi.fn(async () => reply({ error: "nope" }, 503)) as unknown as typeof fetch;
    const notes: string[] = [];
    const { spoken } = await run(fetchImpl, (n) => notes.push(n));
    expect(spoken).toBe(0);
    expect(notes.join(" ")).toMatch(/HTTP 503/);
  });

  it("keeps the small budget while it can still ask for less thinking", async () => {
    // 200 tokens is ample for a sentence and nowhere near enough to think
    // first: measured, a 200-token call to a thinking server returns 882
    // characters of reasoning and an empty content. The large budget is the
    // *last* resort, not the second — a server that accepts `reasoning_effort`
    // needs no more room than one that accepts vLLM's key.
    const caps: number[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      caps.push(body.max_tokens as number);
      if (body.chat_template_kwargs) return reply({ error: { param: "chat_template_kwargs" } }, 400);
      return spoke("A line.");
    }) as unknown as typeof fetch;
    await run(fetchImpl);
    expect(caps[0]).toBe(200);
    expect(caps[1]).toBe(200);
  });
});
