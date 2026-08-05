import type { AgentConfig, PluginContext, ProviderFactory } from "@tailored-ai/core";
import { describe, expect, it } from "vitest";
import plugin, {
  meta,
  OpenAIChatProvider,
  OpenAIResponsesProvider,
  type OpenAIRouterProvider,
  validateConfig,
} from "../index.js";

function registerPlugin() {
  const factories = new Map<string, ProviderFactory>();
  const ctx = {
    providers: {
      register: (id: string, factory: ProviderFactory) => factories.set(id, factory),
    },
  } as unknown as PluginContext;
  plugin(ctx);
  return factories;
}

function configWith(openai: Record<string, unknown> | undefined): AgentConfig {
  return { providers: { openai } } as unknown as AgentConfig;
}

describe("provider-openai plugin", () => {
  it("registers the openai provider factory (supersedes the built-in id)", () => {
    expect(registerPlugin().has("openai")).toBe(true);
  });

  it("builds a provider and model from providers.openai config", () => {
    const factory = registerPlugin().get("openai");
    const result = factory?.(configWith({ apiKey: "sk-test", defaultModel: "gpt-5-mini" }));
    expect(result?.model).toBe("gpt-5-mini");
    expect(result?.provider.id).toBe("openai");
    expect(result?.provider.supportsTools).toBe(true);
  });

  /**
   * The endpoint is chosen per call rather than per construction (#378), so the
   * registered provider is a router even when `defaultModel` would use chat
   * completions — an agent or a fallback rung may name a model that would not.
   */
  it("routes by the model of each call, not by defaultModel", () => {
    const factory = registerPlugin().get("openai");
    const result = factory?.(configWith({ apiKey: "sk-test", defaultModel: "gpt-5-mini" }));
    const router = result?.provider as OpenAIRouterProvider;

    expect(router.providerFor("gpt-5-mini")).toBeInstanceOf(OpenAIChatProvider);
    expect(router.providerFor("gpt-5.6-luna")).toBeInstanceOf(OpenAIResponsesProvider);
  });

  it("returns the plain chat provider when the endpoint is pinned to chat", () => {
    // Pinning `chat` means the Responses provider can never be reached, so
    // building one would only add a way to be wrong.
    const factory = registerPlugin().get("openai");
    const result = factory?.(configWith({ apiKey: "sk-test", defaultModel: "gpt-5.6-luna", api: "chat" }));
    expect(result?.provider).toBeInstanceOf(OpenAIChatProvider);
  });

  it("throws on missing config, apiKey, or defaultModel", () => {
    const factory = registerPlugin().get("openai");
    expect(() => factory?.(configWith(undefined))).toThrow(/providers\.openai not configured/);
    expect(() => factory?.(configWith({ defaultModel: "m" }))).toThrow(/requires an apiKey/);
    expect(() => factory?.(configWith({ apiKey: "k" }))).toThrow(/requires a defaultModel/);
  });
});

describe("plugin meta + validateConfig", () => {
  it("declares the provider registration", () => {
    expect(meta.registers).toEqual([{ kind: "provider", id: "openai", configKey: "providers.openai" }]);
    expect(meta.description).toBeTruthy();
  });

  it("warns on missing apiKey / defaultModel, stays quiet otherwise", () => {
    expect(validateConfig(configWith({}))).toHaveLength(2);
    expect(validateConfig(configWith({ apiKey: "k", defaultModel: "m" }))).toEqual([]);
    expect(validateConfig(configWith(undefined))).toEqual([]);
  });
});
