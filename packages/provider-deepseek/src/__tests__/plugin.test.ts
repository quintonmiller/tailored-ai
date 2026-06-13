import type { AgentConfig, PluginContext, ProviderFactory } from "@tailored-ai/core";
import { OpenAIProvider } from "@tailored-ai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin, { createDeepSeekProvider, DEEPSEEK_BASE_URL, meta, validateConfig } from "../index.js";

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

function configWith(deepseek: Record<string, unknown> | undefined): AgentConfig {
  return { providers: { deepseek } } as unknown as AgentConfig;
}

afterEach(() => vi.unstubAllGlobals());

describe("provider-deepseek plugin", () => {
  it("registers the deepseek provider factory", () => {
    expect(registerPlugin().has("deepseek")).toBe(true);
  });

  it("builds a provider and model from providers.deepseek config", () => {
    const factory = registerPlugin().get("deepseek");
    const result = factory?.(configWith({ apiKey: "sk-test", defaultModel: "deepseek-chat" }));
    expect(result?.model).toBe("deepseek-chat");
    expect(result?.provider).toBeInstanceOf(OpenAIProvider);
    expect(result?.provider.id).toBe("deepseek");
    expect(result?.provider.name).toBe("DeepSeek");
    expect(result?.provider.supportsTools).toBe(true);
  });

  it("throws when providers.deepseek is missing", () => {
    const factory = registerPlugin().get("deepseek");
    expect(() => factory?.(configWith(undefined))).toThrow(/providers\.deepseek not configured/);
  });

  it("throws when apiKey or defaultModel is missing", () => {
    const factory = registerPlugin().get("deepseek");
    expect(() => factory?.(configWith({ defaultModel: "m" }))).toThrow(/requires an apiKey/);
    expect(() => factory?.(configWith({ apiKey: "k" }))).toThrow(/requires a defaultModel/);
  });

  it("targets the DeepSeek endpoint with Bearer auth", async () => {
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

    const provider = createDeepSeekProvider({ apiKey: "sk-test", defaultModel: "m" });
    await provider.chat({ model: "m", messages: [{ role: "user", content: "Hi" }] });

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${DEEPSEEK_BASE_URL}/chat/completions`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
  });

  it("honors a baseUrl override", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const provider = createDeepSeekProvider({ apiKey: "k", baseUrl: "http://proxy.local/v1" });
    await provider.listModels?.();
    expect(fetchSpy.mock.calls[0][0]).toBe("http://proxy.local/v1/models");
  });
});

describe("thinking-mode injection", () => {
  function chatBody(fetchSpy: ReturnType<typeof vi.fn>): Record<string, unknown> {
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    return JSON.parse(init.body as string) as Record<string, unknown>;
  }

  function stubOkChat() {
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
    return fetchSpy;
  }

  it("sends thinking:{type:disabled} when thinking is false", async () => {
    const fetchSpy = stubOkChat();
    const provider = createDeepSeekProvider({ apiKey: "k", thinking: false });
    await provider.chat({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "Hi" }] });
    expect(chatBody(fetchSpy).thinking).toEqual({ type: "disabled" });
  });

  it("sends thinking:{type:enabled} when thinking is true", async () => {
    const fetchSpy = stubOkChat();
    const provider = createDeepSeekProvider({ apiKey: "k", thinking: true });
    await provider.chat({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "Hi" }] });
    expect(chatBody(fetchSpy).thinking).toEqual({ type: "enabled" });
  });

  it("omits thinking entirely when not configured", async () => {
    const fetchSpy = stubOkChat();
    const provider = createDeepSeekProvider({ apiKey: "k" });
    await provider.chat({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "Hi" }] });
    expect(chatBody(fetchSpy)).not.toHaveProperty("thinking");
  });

  it("lets a per-call extra override the configured thinking mode", async () => {
    const fetchSpy = stubOkChat();
    const provider = createDeepSeekProvider({ apiKey: "k", thinking: false });
    await provider.chat({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "Hi" }],
      extra: { thinking: { type: "enabled" } },
    });
    expect(chatBody(fetchSpy).thinking).toEqual({ type: "enabled" });
  });
});

describe("plugin meta + validateConfig", () => {
  it("declares the provider registration", () => {
    expect(meta.registers).toEqual([{ kind: "provider", id: "deepseek", configKey: "providers.deepseek" }]);
    expect(meta.description).toBeTruthy();
  });

  it("warns on missing apiKey / defaultModel, stays quiet otherwise", () => {
    expect(validateConfig(configWith({}))).toHaveLength(2);
    expect(validateConfig(configWith({ apiKey: "k" }))).toEqual([expect.stringContaining("defaultModel")]);
    expect(validateConfig(configWith({ apiKey: "k", defaultModel: "m" }))).toEqual([]);
    expect(validateConfig(configWith(undefined))).toEqual([]);
  });
});
