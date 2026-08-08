/**
 * Sampling controls core does not model.
 *
 * Core sends `temperature` and `max_tokens` on the generation call and nothing
 * else. That is fine until a model needs more: omega-evolution-27b re-sends its
 * own previous message nearly verbatim (measured 15/16, word-trigram overlap
 * 0.90 against the agent's own prior reply) unless vLLM's `repetition_penalty`
 * is raised, and neither temperature nor prompt wording substitutes for it —
 * an explicit "do not repeat" instruction measured 20/20.
 *
 * `ChatParams.extra` and the provider-side merge both already existed; nothing
 * on the agent's generation path populated them, and `providerExtra` in config
 * reached only `briefing` and `suggestions`. These tests pin the wiring from
 * config through to the request body, and the one semantic that is a real
 * choice: a chain rung REPLACES the bag rather than merging into it.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAgent } from "../agent/agents.js";
import { applyCandidateParams, runAgentLoop } from "../agent/loop.js";
import { newSession } from "../agent/session.js";
import type { AgentConfig } from "../config.js";
import { initDatabase } from "../db/schema.js";
import type { AIProvider, ChatParams, ChatResponse } from "../providers/interface.js";
import { OpenAIProvider } from "../providers/openai.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function configWith(over: Partial<AgentConfig["agent"]>, agents?: AgentConfig["agents"]): AgentConfig {
  return {
    agent: {
      defaultProvider: "local",
      extraInstructions: "",
      maxHistoryTokens: 1000,
      maxToolOutputChars: 1000,
      maxContextTokens: 1000,
      temperature: 0.3,
      maxToolRounds: 8,
      ...over,
    },
    providers: { local: { defaultModel: "m" } },
    ...(agents ? { agents } : {}),
  } as unknown as AgentConfig;
}

describe("providerExtra reaches the resolved agent", () => {
  it("is undefined when nothing sets it, so the request is unchanged", () => {
    const r = resolveAgent(undefined, configWith({}), []);
    expect(r.providerExtra).toBeUndefined();
  });

  it("comes from the deployment default", () => {
    const r = resolveAgent(undefined, configWith({ providerExtra: { repetition_penalty: 1.15 } }), []);
    expect(r.providerExtra).toEqual({ repetition_penalty: 1.15 });
  });

  it("lets an agent override the deployment default", () => {
    const config = configWith({ providerExtra: { repetition_penalty: 1.15 } }, {
      lila: { providerExtra: { repetition_penalty: 1.2, top_k: 20 } },
    } as unknown as AgentConfig["agents"]);
    expect(resolveAgent("lila", config, []).providerExtra).toEqual({ repetition_penalty: 1.2, top_k: 20 });
  });

  it("replaces the deployment bag wholesale rather than merging into it", () => {
    // The agent's bag is shaped for the provider the agent actually uses. A
    // merge would leak a deployment-wide vLLM key into an agent on Anthropic.
    const config = configWith({ providerExtra: { repetition_penalty: 1.15, top_k: 20 } }, {
      cloud: { providerExtra: { top_p: 0.9 } },
    } as unknown as AgentConfig["agents"]);
    expect(resolveAgent("cloud", config, []).providerExtra).toEqual({ top_p: 0.9 });
  });
});

describe("a model-chain rung", () => {
  const base = { messages: [], temperature: 0.7, extra: { repetition_penalty: 1.15 } };

  it("inherits the call's bag when it declares none", () => {
    const out = applyCandidateParams(base, { provider: {} as never, model: "m", label: "local" });
    expect(out.extra).toEqual({ repetition_penalty: 1.15 });
  });

  it("replaces it when it declares its own", () => {
    // The case that matters: a local head with a cloud fallback. Sending
    // vLLM's repetition_penalty to Anthropic is a field it has never heard of.
    const out = applyCandidateParams(base, {
      provider: {} as never,
      model: "claude",
      label: "anthropic",
      providerExtra: { top_p: 0.9 },
    });
    expect(out.extra).toEqual({ top_p: 0.9 });
  });
});

describe("the loop forwards it on the generation call", () => {
  /** Captures what the loop actually handed the provider. */
  function recordingProvider(seen: ChatParams[]): AIProvider {
    return {
      id: "fake",
      name: "fake",
      supportsTools: true,
      async chat(params: ChatParams): Promise<ChatResponse> {
        seen.push(params);
        return { content: "ok", usage: { input: 0, output: 0 }, finishReason: "stop" };
      },
    };
  }

  function run(seen: ChatParams[], over: Record<string, unknown> = {}) {
    return runAgentLoop("go", {
      provider: recordingProvider(seen),
      session: newSession(db, "fake-model", "fake"),
      db,
      tools: [],
      extraInstructions: "",
      maxToolRounds: 2,
      maxHistoryTokens: 5000,
      temperature: 0.3,
      ...over,
    });
  }

  it("sends nothing extra when the agent declares none", async () => {
    const seen: ChatParams[] = [];
    await run(seen);
    expect(seen[0].extra).toBeUndefined();
  });

  it("hands the resolved bag to the provider", async () => {
    // The line this pins is the whole feature: ChatParams.extra and the
    // provider-side merge both already existed, and nothing on this path ever
    // populated them.
    const seen: ChatParams[] = [];
    await run(seen, { providerExtra: { repetition_penalty: 1.15, top_k: 20 } });

    expect(seen).toHaveLength(1);
    expect(seen[0].extra).toEqual({ repetition_penalty: 1.15, top_k: 20 });
  });
});

describe("the provider puts it on the wire", () => {
  // buildBody is private and shared by chat() and chatStream(); reaching it
  // directly is the only way to assert the body without a live server.
  const bodyFor = (extra?: Record<string, unknown>) => {
    const p = new OpenAIProvider({ baseUrl: "http://x", defaultModel: "m" });
    return (p as unknown as { buildBody(params: unknown): Record<string, unknown> }).buildBody({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.7,
      extra,
    });
  };

  it("omits nothing extra when unset", () => {
    expect(bodyFor()).not.toHaveProperty("repetition_penalty");
  });

  it("merges the bag onto the request body", () => {
    expect(bodyFor({ repetition_penalty: 1.15, top_k: 20 })).toMatchObject({
      repetition_penalty: 1.15,
      top_k: 20,
      temperature: 0.7,
    });
  });

  it("lets the bag win over a field core would otherwise set", () => {
    // Documented precedence, and the escape hatch when core's mapping is wrong
    // for a particular server.
    expect(bodyFor({ temperature: 0.1 }).temperature).toBe(0.1);
  });
});
