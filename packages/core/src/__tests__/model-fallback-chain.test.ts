import { describe, expect, it, vi } from "vitest";
import { resolveAgent } from "../agent/agents.js";
import { chatWithFallback } from "../agent/loop.js";
import type { AgentConfig, AgentDefinition } from "../config.js";
import type { AIProvider, ChatParams, ChatResponse } from "../providers/interface.js";
import type { Tool, ToolContext, ToolResult } from "../tools/interface.js";

function tool(name: string): Tool {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    async execute(_args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      return { success: true, output: name };
    },
  };
}

function baseConfig(
  over: Partial<AgentConfig["agent"]> = {},
  agents: Record<string, AgentDefinition> = {},
): AgentConfig {
  return {
    agent: {
      defaultProvider: "local",
      temperature: 0.3,
      maxToolRounds: 10,
      maxHistoryTokens: 2000,
      extraInstructions: "base",
      ...over,
    },
    providers: {
      local: { baseUrl: "http://127.0.0.1:8000/v1", defaultModel: "qwen-local" },
      cloud: { baseUrl: "https://api.example.com/v1", defaultModel: "cloud-big" },
      other: { baseUrl: "https://other.example.com/v1", defaultModel: "other-default" },
    },
    agents,
    tools: {},
  } as unknown as AgentConfig;
}

const resolve = (name: string | undefined, config: AgentConfig, modelOverride?: string) =>
  resolveAgent(name, config, [tool("read")], modelOverride, undefined, undefined, {
    resolveAgentDef: (id) => config.agents?.[id],
  });

describe("resolveAgent — fallback chain", () => {
  it("synthesizes a one-entry chain when nothing declares models[]", () => {
    const resolved = resolve(undefined, baseConfig());
    expect(resolved.models).toEqual([{ provider: "local", model: "qwen-local" }]);
    // The head is always the pair the pre-chain fields name, so a caller that
    // reads only `provider`/`model` stays correct.
    expect(resolved.provider).toBe("local");
    expect(resolved.model).toBe("qwen-local");
  });

  it("uses the deployment chain and takes its head as provider/model", () => {
    const config = baseConfig({
      models: [
        { provider: "local", model: "qwen-local" },
        { provider: "cloud", model: "cloud-big" },
      ],
    });
    const resolved = resolve(undefined, config);
    expect(resolved.models.map((m) => `${m.provider}/${m.model}`)).toEqual(["local/qwen-local", "cloud/cloud-big"]);
    expect(resolved.provider).toBe("local");
    expect(resolved.model).toBe("qwen-local");
  });

  it("prefers an agent's own chain over the deployment chain", () => {
    const config = baseConfig(
      { models: [{ provider: "local", model: "qwen-local" }] },
      {
        picky: {
          models: [
            { provider: "cloud", model: "cloud-big" },
            { provider: "other", model: "other-x" },
          ],
        },
      },
    );
    const resolved = resolve("picky", config);
    expect(resolved.models.map((m) => m.provider)).toEqual(["cloud", "other"]);
    expect(resolved.model).toBe("cloud-big");
  });

  it("does not opt an agent that pins one model into the deployment chain", () => {
    // Pinning exists to send this agent somewhere specific. Silently failing
    // over to the deployment default would undo the pin.
    const config = baseConfig(
      {
        models: [
          { provider: "local", model: "qwen-local" },
          { provider: "cloud", model: "cloud-big" },
        ],
      },
      {
        pinned: { provider: "other", model: "other-x" },
      },
    );
    const resolved = resolve("pinned", config);
    expect(resolved.models).toEqual([{ provider: "other", model: "other-x" }]);
  });

  it("lets models[] win over a same-agent model pin, and says so once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = baseConfig(
      {},
      {
        conflicted_agent: { model: "ignored-pin", models: [{ provider: "cloud", model: "cloud-big" }] },
      },
    );
    const resolved = resolve("conflicted_agent", config);
    expect(resolved.model).toBe("cloud-big");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("sets both models[] and model/provider"));
    warn.mockRestore();
  });

  it("keeps an explicit per-call model override out of the chain", () => {
    // Someone who named one model for one call did not ask to be answered by
    // a different one.
    const config = baseConfig({
      models: [
        { provider: "local", model: "qwen-local" },
        { provider: "cloud", model: "cloud-big" },
      ],
    });
    const resolved = resolve(undefined, config, "one-off-model");
    expect(resolved.models).toEqual([{ provider: "local", model: "one-off-model" }]);
  });

  it("drops malformed entries and collapses duplicates", () => {
    const config = baseConfig({
      models: [
        { provider: "local", model: "qwen-local" },
        { provider: "local", model: "qwen-local" },
        { provider: "cloud" } as never,
        { model: "no-provider" } as never,
        { provider: "cloud", model: "cloud-big" },
      ],
    });
    const resolved = resolve(undefined, config);
    expect(resolved.models).toEqual([
      { provider: "local", model: "qwen-local" },
      { provider: "cloud", model: "cloud-big" },
    ]);
  });
});

function fakeProvider(id: string, behaviour: (params: ChatParams) => Promise<ChatResponse>): AIProvider {
  return {
    id,
    name: id,
    chat: (params) => behaviour(params),
  } as AIProvider;
}

/** The loop always passes these; the chain only varies the provider+model. */
const callChain = (candidates: Parameters<typeof chatWithFallback>[0]) =>
  chatWithFallback(candidates, { messages: [{ role: "user", content: "hi" }], temperature: 0.3 });

describe("chatWithFallback", () => {
  it("moves to the next candidate when the first throws, and reports which answered", async () => {
    const calls: string[] = [];
    const down = fakeProvider("local", async () => {
      calls.push("local");
      throw new Error("connect ECONNREFUSED 127.0.0.1:8000");
    });
    const up = fakeProvider("cloud", async () => {
      calls.push("cloud");
      return { content: "hello from cloud", usage: { input: 10, output: 2 } } as ChatResponse;
    });

    const result = await callChain([
      { provider: down, model: "qwen-local", label: "local" },
      { provider: up, model: "cloud-big", label: "cloud" },
    ]);

    expect(calls).toEqual(["local", "cloud"]);
    expect(result.response.content).toBe("hello from cloud");
    expect(result.candidate.label).toBe("cloud");
    expect(result.fellBack).toBe(true);
  });

  it("does not retry a non-final candidate — it moves on immediately", async () => {
    let localCalls = 0;
    const down = fakeProvider("local", async () => {
      localCalls++;
      throw new Error("503 Service Unavailable");
    });
    const up = fakeProvider("cloud", async () => ({ content: "ok" }) as ChatResponse);

    await callChain([
      { provider: down, model: "m1", label: "local" },
      { provider: up, model: "m2", label: "cloud" },
    ]);
    // Spending a second and a second failed call on a model that just refused,
    // while a working one waits, is strictly worse than moving on.
    expect(localCalls).toBe(1);
  });

  it("retries the last candidate, preserving single-model behaviour", async () => {
    let attempts = 0;
    const flaky = fakeProvider("local", async () => {
      attempts++;
      if (attempts === 1) throw new Error("transient blip");
      return { content: "second time lucky" } as ChatResponse;
    });

    const result = await callChain([{ provider: flaky, model: "m", label: "local" }]);
    expect(attempts).toBe(2);
    expect(result.response.content).toBe("second time lucky");
    expect(result.fellBack).toBe(false);
  });

  it("throws the first error when every candidate fails", async () => {
    // The primary's failure is the one that explains the outage; later rungs
    // failing is expected once the primary is down.
    const a = fakeProvider("local", async () => {
      throw new Error("primary is down");
    });
    const b = fakeProvider("cloud", async () => {
      throw new Error("secondary also down");
    });
    await expect(
      callChain([
        { provider: a, model: "m1", label: "local" },
        { provider: b, model: "m2", label: "cloud" },
      ]),
    ).rejects.toThrow("primary is down");
  });

  it("sends each candidate its own model id, not the primary's", async () => {
    const seen: string[] = [];
    const a = fakeProvider("local", async (p) => {
      seen.push(p.model);
      throw new Error("nope");
    });
    const b = fakeProvider("cloud", async (p) => {
      seen.push(p.model);
      return { content: "ok" } as ChatResponse;
    });
    await callChain([
      { provider: a, model: "qwen-local", label: "local" },
      { provider: b, model: "cloud-big", label: "cloud" },
    ]);
    // Sending the primary's model name to the fallback's endpoint is the exact
    // 404-for-a-model-that-exists this chain is meant to avoid.
    expect(seen).toEqual(["qwen-local", "cloud-big"]);
  });
});
