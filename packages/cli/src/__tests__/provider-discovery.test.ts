import type { AgentConfig, AIProvider, ChatResponse } from "@tailored-ai/core";
import { describe, expect, it } from "vitest";
import { buildProbeConfig, discoverProviders, listModelsFor } from "../editor/provider-discovery.js";

function fakeProvider(models?: string[]): AIProvider {
  return {
    id: "fake",
    name: "Fake",
    supportsTools: true,
    async chat(): Promise<ChatResponse> {
      return { content: "ok", usage: { input: 0, output: 0 }, finishReason: "stop" };
    },
    ...(models ? { listModels: async () => models } : {}),
  } as AIProvider;
}

describe("discoverProviders", () => {
  it("always includes the registry built-ins", async () => {
    const found = await discoverProviders("/tmp/does-not-matter");
    const ids = found.map((p) => p.id);
    expect(ids).toContain("openai_compatible");
    expect(ids).toContain("openai");
    expect(ids).toContain("anthropic");
    expect(found.every((p) => typeof p.factory === "function")).toBe(true);
  });

  it("skips builtin: entries and tolerates a config with no plugins", async () => {
    const config = { plugins: ["builtin:stall-guard"], providers: {} } as unknown as AgentConfig;
    const found = await discoverProviders("/tmp/does-not-matter", config);
    expect(found.every((p) => p.source === "builtin")).toBe(true);
  });
});

describe("listModelsFor", () => {
  const config = { providers: {} } as unknown as AgentConfig;

  it("returns the provider's model catalog", async () => {
    const entry = {
      id: "fake",
      source: "plugin" as const,
      factory: () => ({ provider: fakeProvider(["m1", "m2"]), model: "m1" }),
    };
    await expect(listModelsFor(entry, config)).resolves.toEqual(["m1", "m2"]);
  });

  it("returns undefined when the provider has no listModels", async () => {
    const entry = {
      id: "fake",
      source: "plugin" as const,
      factory: () => ({ provider: fakeProvider(), model: "m1" }),
    };
    await expect(listModelsFor(entry, config)).resolves.toBeUndefined();
  });

  it("returns undefined when the factory throws (unconfigured provider)", async () => {
    const entry = {
      id: "fake",
      source: "plugin" as const,
      factory: () => {
        throw new Error("providers.fake not configured");
      },
    };
    await expect(listModelsFor(entry, config)).resolves.toBeUndefined();
  });

  it("returns undefined when listModels rejects", async () => {
    const provider = fakeProvider();
    (provider as unknown as { listModels: () => Promise<string[]> }).listModels = async () => {
      throw new Error("server down");
    };
    const entry = { id: "fake", source: "plugin" as const, factory: () => ({ provider, model: "m" }) };
    await expect(listModelsFor(entry, config)).resolves.toBeUndefined();
  });
});

describe("buildProbeConfig", () => {
  it("overlays draft fields onto the existing provider block", () => {
    const base = {
      providers: { bedrock: { region: "us-west-2", defaultModel: "old-model" } },
      agent: { defaultProvider: "bedrock" },
    } as unknown as AgentConfig;
    const probe = buildProbeConfig("bedrock", { defaultModel: "new-model" }, base);
    expect(probe.providers.bedrock).toEqual({ region: "us-west-2", defaultModel: "new-model" });
  });

  it("keeps the existing defaultModel when the draft has none", () => {
    const base = { providers: { openai: { defaultModel: "gpt" } } } as unknown as AgentConfig;
    const probe = buildProbeConfig("openai", {}, base);
    expect((probe.providers.openai as { defaultModel: string }).defaultModel).toBe("gpt");
  });

  it("synthesizes a minimal config with a placeholder model for fresh installs", () => {
    const probe = buildProbeConfig("openai_compatible", { baseUrl: "http://localhost:11434/v1" });
    expect(probe.providers.openai_compatible).toEqual({
      baseUrl: "http://localhost:11434/v1",
      defaultModel: "model-discovery",
    });
  });
});
