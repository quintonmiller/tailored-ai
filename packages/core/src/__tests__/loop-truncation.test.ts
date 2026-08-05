/**
 * `agent.maxTokens` goes out as `max_completion_tokens`, which on a reasoning
 * model caps reasoning *plus* visible output rather than output alone. A hard
 * turn can spend the entire budget thinking and return an empty message with
 * `finish_reason: "length"`, billed in full — `gpt-5-mini` spent 384 of 420
 * output tokens on reasoning for a single tool call on a *trivial* task.
 *
 * What made this worth fixing is not the cap but the silence: an empty
 * assistant message is indistinguishable from a model that had nothing to say.
 * The loop now says which model, which cap, and which knob moves it.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeTruncation, type LoopStop, runAgentLoop } from "../agent/loop.js";
import { newSession } from "../agent/session.js";
import { initDatabase } from "../db/schema.js";
import type { AIProvider, ChatResponse } from "../providers/interface.js";

let db: Database.Database;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  db = initDatabase(":memory:");
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

function provider(response: Partial<ChatResponse>): AIProvider {
  return {
    id: "fake",
    name: "fake",
    supportsTools: true,
    async chat() {
      return {
        content: null,
        usage: { input: 100, output: 8192 },
        finishReason: "length",
        ...response,
      } as ChatResponse;
    },
  } as AIProvider;
}

function run(p: AIProvider, over: Record<string, unknown> = {}) {
  const stops: LoopStop[] = [];
  const promise = runAgentLoop("do something hard", {
    provider: p,
    session: newSession(db, "gpt-5-mini", "fake"),
    db,
    tools: [],
    extraInstructions: "",
    maxToolRounds: 4,
    maxHistoryTokens: 5000,
    temperature: 0.3,
    maxTokens: 8192,
    onStop: (s: LoopStop) => stops.push(s),
    ...over,
  });
  return promise.then((text) => ({ text, stops }));
}

describe("output truncation", () => {
  it("explains an empty turn instead of returning an empty string", async () => {
    const { text } = await run(provider({ content: null, reasoning: "thinking hard..." }));

    expect(text).not.toBe("");
    expect(text).toContain("output limit");
    expect(text).toContain("gpt-5-mini");
    expect(text).toContain("8192");
  });

  it("names reasoning as the consumer when that is what happened", async () => {
    const { text, stops } = await run(provider({ content: null, reasoning: "long chain of thought" }));

    expect(text).toContain("reasoning");
    expect(text).toMatch(/lower its reasoning effort/);
    expect(stops).toEqual([
      {
        kind: "truncated",
        model: "gpt-5-mini",
        maxTokens: 8192,
        outputTokens: 8192,
        spentOnReasoning: true,
      },
    ]);
  });

  it("does not blame reasoning when the model reported none", async () => {
    const { text, stops } = await run(provider({ content: null }));

    expect(text).not.toContain("reasoning");
    expect((stops[0] as { spentOnReasoning: boolean }).spentOnReasoning).toBe(false);
  });

  it("reports the truncation through onStop, not only the return value", async () => {
    const { stops } = await run(provider({ content: null }));
    expect(stops).toHaveLength(1);
    expect(stops[0].kind).toBe("truncated");
  });

  it("does not nudge a model that ran out of budget", async () => {
    // A nudge spends another full round to arrive at the same place.
    const { stops } = await run(provider({ content: null }), { nudgeOnText: 3 });
    expect(stops[0].kind).toBe("truncated");
  });

  it("keeps a reply that was cut off mid-sentence, but says so", async () => {
    const { text, stops } = await run(provider({ content: "The answer is that you should" }));

    expect(text).toBe("The answer is that you should");
    expect(stops[0].kind).toBe("complete");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("mid-reply"));
  });

  it("leaves a normal turn alone", async () => {
    const { text, stops } = await run(
      provider({ content: "done", finishReason: "stop", usage: { input: 10, output: 5 } }),
    );

    expect(text).toBe("done");
    expect(stops).toEqual([{ kind: "complete" }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("names the model that actually answered, not the one configured", async () => {
    // The chain can hand the turn to a fallback, whose cap is the one that bit.
    const fallback = provider({ content: null });
    const { text } = await run(provider({ content: null }), {
      getModelChain: () => [{ provider: fallback, model: "claude-sonnet-5", label: "anthropic" }],
    });
    expect(text).toContain("claude-sonnet-5");
  });
});

describe("describeTruncation", () => {
  it("omits what it does not know", () => {
    const out = describeTruncation({ kind: "truncated", model: "m", spentOnReasoning: false });
    expect(out).toContain("m reached its output limit");
    expect(out).not.toContain("undefined");
    expect(out).not.toContain("maxTokens is");
  });
});
