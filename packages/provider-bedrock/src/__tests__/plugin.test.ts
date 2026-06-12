import type { AgentConfig, PluginContext, ProviderFactory } from "@tailored-ai/core";
import { describe, expect, it } from "vitest";
import plugin, { BedrockProvider } from "../index.js";

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

function configWith(bedrock: Record<string, unknown> | undefined): AgentConfig {
  return { providers: { bedrock } } as unknown as AgentConfig;
}

describe("provider-bedrock plugin", () => {
  it("registers the bedrock provider factory", () => {
    const factories = registerPlugin();
    expect(factories.has("bedrock")).toBe(true);
  });

  it("builds a provider and model from providers.bedrock config", () => {
    const factory = registerPlugin().get("bedrock");
    const result = factory?.(
      configWith({ defaultModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0", region: "us-west-2" }),
    );
    expect(result?.model).toBe("us.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(result?.provider).toBeInstanceOf(BedrockProvider);
    expect(result?.provider.id).toBe("bedrock");
    expect(result?.provider.supportsTools).toBe(true);
  });

  it("throws when providers.bedrock is missing", () => {
    const factory = registerPlugin().get("bedrock");
    expect(() => factory?.(configWith(undefined))).toThrow(/providers\.bedrock not configured/);
  });

  it("throws when defaultModel is missing", () => {
    const factory = registerPlugin().get("bedrock");
    expect(() => factory?.(configWith({ region: "us-west-2" }))).toThrow(/requires a defaultModel/);
  });
});
