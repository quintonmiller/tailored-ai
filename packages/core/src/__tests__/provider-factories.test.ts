import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../config.js";
import { createEmbedder, createProvider } from "../factories.js";
import {
  embeddingFactoryRegistry,
  providerFactoryRegistry,
  registerEmbeddingFactory,
  registerProviderFactory,
} from "../providers/factories.js";
import type { AIProvider } from "../providers/interface.js";

const baseConfig = (overrides: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    agent: { defaultProvider: "openai" },
    providers: { openai: { apiKey: "k", baseUrl: "u", defaultModel: "m" } },
    ...overrides,
  }) as unknown as AgentConfig;

describe("provider factory registry", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    providerFactoryRegistry.unregister("custom-test");
    embeddingFactoryRegistry.unregister("custom-test");
  });

  it("ships openai, anthropic, openai_compatible as built-ins", () => {
    const ids = providerFactoryRegistry.list();
    expect(ids).toContain("openai");
    expect(ids).toContain("anthropic");
    expect(ids).toContain("openai_compatible");
  });

  it("resolves a built-in provider through createProvider", () => {
    const { provider, model } = createProvider(baseConfig());
    expect(model).toBe("m");
    expect(provider).toBeDefined();
  });

  it("throws with a helpful list when the provider id is unknown", () => {
    expect(() => createProvider(baseConfig({ agent: { defaultProvider: "ghost" } } as never))).toThrow(
      /No provider factory registered.*Known:/,
    );
  });

  it("third party can register a custom provider factory", () => {
    const fake: AIProvider = {
      id: "custom-test",
      name: "Custom",
      supportsTools: false,
      chat: async () => ({ content: "", role: "assistant" }) as never,
    };
    registerProviderFactory("custom-test", () => ({ provider: fake, model: "x" }));
    const { provider } = createProvider(baseConfig({ agent: { defaultProvider: "custom-test" } } as never));
    expect(provider).toBe(fake);
  });
});

describe("embedding factory registry", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    embeddingFactoryRegistry.unregister("custom-test");
  });

  it("returns undefined when memory.embeddings is disabled", () => {
    expect(createEmbedder(baseConfig())).toBeUndefined();
  });

  it("returns undefined when factory id is unknown", () => {
    const cfg = baseConfig({
      memory: { embeddings: { enabled: true, type: "ghost", baseUrl: "u", model: "m" } },
    } as never);
    expect(createEmbedder(cfg)).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("No embedding factory"));
  });

  it("third party can register a custom embedding factory", () => {
    const fake = { id: "fake" } as never;
    registerEmbeddingFactory("custom-test", () => fake);
    const cfg = baseConfig({
      memory: { embeddings: { enabled: true, type: "custom-test" } },
    } as never);
    expect(createEmbedder(cfg)).toBe(fake);
  });
});
