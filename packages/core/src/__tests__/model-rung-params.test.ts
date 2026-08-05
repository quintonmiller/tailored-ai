/**
 * A fallback chain that heads at a small local model and falls back to a strong
 * cloud reasoner wants different settings at each end, and one global
 * `agent.thinking` cannot give them: set it for the head and the fallback is
 * wasted, set it for the fallback and the head is burdened. The provider's
 * `defaultThinking` is keyed by provider, so two rungs on the same provider
 * could not differ either.
 *
 * `ModelEntry` now carries `thinking`, `temperature` and `maxTokens`. The
 * contract that matters is the absent case: a rung that says nothing must be
 * indistinguishable from one written before these fields existed.
 */
import { describe, expect, it } from "vitest";
import { applyCandidateParams, chatWithFallback, type ModelCandidate } from "../agent/loop.js";
import type { AgentConfig } from "../config.js";
import { findShapeIssues } from "../config-schema.js";
import type { AIProvider, ChatParams, ChatResponse } from "../providers/interface.js";

function fakeProvider(id: string, behaviour: (params: ChatParams) => Promise<ChatResponse>): AIProvider {
  return { id, name: id, chat: (params) => behaviour(params) } as AIProvider;
}

const CALL = {
  messages: [{ role: "user" as const, content: "hi" }],
  temperature: 0.3,
  thinking: "off" as const,
  maxTokens: 8192,
};

describe("applyCandidateParams", () => {
  const base: ModelCandidate = { provider: {} as AIProvider, model: "m", label: "l" };

  it("inherits every field a rung does not set", () => {
    expect(applyCandidateParams(CALL, base)).toEqual({ ...CALL, model: "m" });
  });

  it("does not erase an inherited value with an absent override", () => {
    // The bug a `{...params, ...candidate}` spread would produce: `thinking:
    // undefined` on the candidate overwriting the call's "off".
    const withUndefined = { ...base, thinking: undefined, temperature: undefined, maxTokens: undefined };
    const out = applyCandidateParams(CALL, withUndefined);
    expect(out.thinking).toBe("off");
    expect(out.temperature).toBe(0.3);
    expect(out.maxTokens).toBe(8192);
  });

  it("applies the rung's own values when it sets them", () => {
    const out = applyCandidateParams(CALL, { ...base, thinking: "high", temperature: 1, maxTokens: 32000 });
    expect(out).toMatchObject({ thinking: "high", temperature: 1, maxTokens: 32000, model: "m" });
  });

  it("overrides each field independently", () => {
    const out = applyCandidateParams(CALL, { ...base, thinking: "medium" });
    expect(out.thinking).toBe("medium");
    expect(out.temperature).toBe(0.3);
    expect(out.maxTokens).toBe(8192);
  });

  it("never lets a rung change the messages or tools it was handed", () => {
    const out = applyCandidateParams(CALL, { ...base, thinking: "high" });
    expect(out.messages).toBe(CALL.messages);
  });
});

describe("chatWithFallback — per-rung params", () => {
  it("gives each rung its own settings", async () => {
    const seen: Array<Partial<ChatParams>> = [];
    const record = (id: string, fail: boolean) =>
      fakeProvider(id, async (p) => {
        seen.push({ model: p.model, thinking: p.thinking, maxTokens: p.maxTokens });
        if (fail) throw new Error("down");
        return { content: "ok" } as ChatResponse;
      });

    await chatWithFallback(
      [
        // Local: reasoning is a poor trade, and the cap is fine.
        { provider: record("local", true), model: "qwen-local", label: "local", thinking: "off" },
        // Cloud: worth paying for, and a bigger cap because reasoning eats it.
        {
          provider: record("cloud", false),
          model: "gpt-5.6-luna",
          label: "cloud",
          thinking: "high",
          maxTokens: 32000,
        },
      ],
      CALL,
    );

    expect(seen).toEqual([
      { model: "qwen-local", thinking: "off", maxTokens: 8192 },
      { model: "gpt-5.6-luna", thinking: "high", maxTokens: 32000 },
    ]);
  });

  it("lets two rungs on the same provider differ — what defaultThinking could not do", async () => {
    const seen: Array<string | undefined> = [];
    const provider = fakeProvider("openai", async (p) => {
      seen.push(p.thinking);
      if (p.model === "cheap") throw new Error("down");
      return { content: "ok" } as ChatResponse;
    });

    await chatWithFallback(
      [
        { provider, model: "cheap", label: "openai", thinking: "off" },
        { provider, model: "expensive", label: "openai", thinking: "high" },
      ],
      CALL,
    );

    expect(seen).toEqual(["off", "high"]);
  });

  it("a chain with no per-rung settings behaves exactly as before", async () => {
    const seen: Array<Partial<ChatParams>> = [];
    const provider = fakeProvider("p", async (p) => {
      seen.push({ thinking: p.thinking, temperature: p.temperature, maxTokens: p.maxTokens });
      return { content: "ok" } as ChatResponse;
    });

    await chatWithFallback([{ provider, model: "m", label: "p" }], CALL);
    expect(seen).toEqual([{ thinking: "off", temperature: 0.3, maxTokens: 8192 }]);
  });
});

describe("config validation", () => {
  // Only `agents.<name>.*` is walked today; the global `agent.*` block is not
  // (#380), so a rung declared there is unchecked either way.
  const config = (entry: Record<string, unknown>) =>
    ({
      agent: { defaultProvider: "local" },
      providers: { local: { baseUrl: "http://x/v1", defaultModel: "m" } },
      agents: { coder: { models: [entry] } },
      tools: {},
    }) as unknown as AgentConfig;

  it("accepts the new per-rung fields", () => {
    const issues = findShapeIssues(
      config({ provider: "local", model: "m", thinking: "high", temperature: 0.7, maxTokens: 32000 }),
    );
    expect(issues).toEqual([]);
  });

  it("rejects a thinking level that is not one", () => {
    const issues = findShapeIssues(config({ provider: "local", model: "m", thinking: "very hard" }));
    expect(issues.join("\n")).toMatch(/thinking/i);
  });

  it("rejects a quoted number, the way YAML users write them", () => {
    const issues = findShapeIssues(config({ provider: "local", model: "m", maxTokens: "32000" }));
    expect(issues.join("\n")).toMatch(/maxTokens/i);
  });
});
