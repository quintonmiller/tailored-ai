import type { AgentConfig, PluginContext, ProviderFactory } from "@tailored-ai/core";
import { OpenAIProvider } from "@tailored-ai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin, { createOpenRouterProvider, meta, OPENROUTER_BASE_URL, validateConfig } from "../index.js";

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

function configWith(openrouter: Record<string, unknown> | undefined): AgentConfig {
  return { providers: { openrouter } } as unknown as AgentConfig;
}

afterEach(() => vi.unstubAllGlobals());

describe("provider-openrouter plugin", () => {
  it("registers the openrouter provider factory", () => {
    expect(registerPlugin().has("openrouter")).toBe(true);
  });

  it("builds a provider and model from providers.openrouter config", () => {
    const factory = registerPlugin().get("openrouter");
    const result = factory?.(configWith({ apiKey: "sk-or-test", defaultModel: "anthropic/claude-haiku-4.5" }));
    expect(result?.model).toBe("anthropic/claude-haiku-4.5");
    expect(result?.provider).toBeInstanceOf(OpenAIProvider);
    expect(result?.provider.id).toBe("openrouter");
    expect(result?.provider.name).toBe("OpenRouter");
    expect(result?.provider.supportsTools).toBe(true);
  });

  it("throws when providers.openrouter is missing", () => {
    const factory = registerPlugin().get("openrouter");
    expect(() => factory?.(configWith(undefined))).toThrow(/providers\.openrouter not configured/);
  });

  it("throws when apiKey or defaultModel is missing", () => {
    const factory = registerPlugin().get("openrouter");
    expect(() => factory?.(configWith({ defaultModel: "m" }))).toThrow(/requires an apiKey/);
    expect(() => factory?.(configWith({ apiKey: "k" }))).toThrow(/requires a defaultModel/);
  });

  it("targets the OpenRouter endpoint with Bearer auth", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const provider = createOpenRouterProvider({ apiKey: "sk-or-test", defaultModel: "m" });
    await provider.chat({ model: "m", messages: [{ role: "user", content: "Hi" }] });

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-or-test");
  });

  it("honors a baseUrl override", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const provider = createOpenRouterProvider({ apiKey: "k", baseUrl: "http://proxy.local/v1" });
    await provider.listModels?.();
    expect(fetchSpy.mock.calls[0][0]).toBe("http://proxy.local/v1/models");
  });

  it("maps thinking to OpenRouter's reasoning param + captures reasoning (#254)", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "OK", reasoning: "because" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const provider = createOpenRouterProvider({ apiKey: "k", defaultModel: "m", thinking: "high" });
    const res = await provider.chat({ model: "m", messages: [{ role: "user", content: "Hi" }] });
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.reasoning).toEqual({ effort: "high" });
    // capture: OpenRouter returns reasoning on message.reasoning
    expect(res.reasoning).toBe("because");
  });
});

describe("plugin meta + validateConfig", () => {
  it("declares the provider registration", () => {
    expect(meta.registers).toEqual([{ kind: "provider", id: "openrouter", configKey: "providers.openrouter" }]);
    expect(meta.description).toBeTruthy();
  });

  it("warns on missing apiKey / defaultModel, stays quiet otherwise", () => {
    expect(validateConfig(configWith({}))).toHaveLength(2);
    expect(validateConfig(configWith({ apiKey: "k" }))).toEqual([expect.stringContaining("defaultModel")]);
    expect(validateConfig(configWith({ apiKey: "k", defaultModel: "m" }))).toEqual([]);
    expect(validateConfig(configWith(undefined))).toEqual([]);
  });
});
