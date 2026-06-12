import type { AgentConfig, PluginContext, ProviderFactory } from "@tailored-ai/core";
import { describe, expect, it } from "vitest";
import plugin, { AnthropicMessagesProvider, meta, validateConfig } from "../index.js";

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

function configWith(anthropic: Record<string, unknown> | undefined): AgentConfig {
  return { providers: { anthropic } } as unknown as AgentConfig;
}

describe("provider-anthropic plugin", () => {
  it("registers the anthropic provider factory (supersedes the built-in id)", () => {
    expect(registerPlugin().has("anthropic")).toBe(true);
  });

  it("builds a provider and model from providers.anthropic config", () => {
    const factory = registerPlugin().get("anthropic");
    const result = factory?.(
      configWith({ apiKey: "sk-ant-test", defaultModel: "claude-haiku-4-5", promptCaching: true }),
    );
    expect(result?.model).toBe("claude-haiku-4-5");
    expect(result?.provider).toBeInstanceOf(AnthropicMessagesProvider);
    expect(result?.provider.id).toBe("anthropic");
    expect(result?.provider.supportsTools).toBe(true);
  });

  it("throws on missing config, apiKey, or defaultModel", () => {
    const factory = registerPlugin().get("anthropic");
    expect(() => factory?.(configWith(undefined))).toThrow(/providers\.anthropic not configured/);
    expect(() => factory?.(configWith({ defaultModel: "m" }))).toThrow(/requires an apiKey/);
    expect(() => factory?.(configWith({ apiKey: "k" }))).toThrow(/requires a defaultModel/);
  });
});

describe("plugin meta + validateConfig", () => {
  it("declares the provider registration", () => {
    expect(meta.registers).toEqual([{ kind: "provider", id: "anthropic", configKey: "providers.anthropic" }]);
    expect(meta.description).toBeTruthy();
  });

  it("warns on missing apiKey / defaultModel, stays quiet otherwise", () => {
    expect(validateConfig(configWith({}))).toHaveLength(2);
    expect(validateConfig(configWith({ apiKey: "k", defaultModel: "m" }))).toEqual([]);
    expect(validateConfig(configWith(undefined))).toEqual([]);
  });
});
