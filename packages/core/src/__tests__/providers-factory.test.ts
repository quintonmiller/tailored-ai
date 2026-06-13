/**
 * Provider resolution tests — built-ins are resolved through the registry
 * by id like any plugin, and read their settings from the backend-opaque
 * `providers.<id>` bag rather than a privileged typed config block.
 */
import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../config.js";
import { createProvider } from "../factories.js";

function cfg(defaultProvider: string, providers: Record<string, Record<string, unknown>>): AgentConfig {
  return { agent: { defaultProvider }, providers } as AgentConfig;
}

describe("createProvider", () => {
  it("builds openai_compatible from the opaque providers bag", () => {
    const { model } = createProvider(
      cfg("openai_compatible", { openai_compatible: { baseUrl: "http://x/v1", defaultModel: "m" } }),
    );
    expect(model).toBe("m");
  });

  it("throws when the selected provider has no defaultModel", () => {
    expect(() => createProvider(cfg("openai_compatible", { openai_compatible: { baseUrl: "http://x/v1" } }))).toThrow(
      /providers\.openai_compatible requires a defaultModel/,
    );
  });

  it("throws a helpful registry error pointing at plugins for an unknown provider id", () => {
    expect(() => createProvider(cfg("mistral", { mistral: { defaultModel: "m" } }))).toThrow(
      /No provider factory registered for "mistral".*Known:.*@tailored-ai\/provider-mistral/,
    );
  });

  // #253: any id can opt into the built-in OpenAIProvider via `type:
  // openai_compatible`, so multiple OpenAI-wire endpoints coexist under
  // distinct ids without a per-vendor plugin.
  describe("inline openai_compatible (#253)", () => {
    it("builds the built-in provider under an arbitrary id via type: openai_compatible", () => {
      const { provider, model } = createProvider(
        cfg("deepseek", {
          deepseek: {
            type: "openai_compatible",
            baseUrl: "https://api.deepseek.com",
            defaultModel: "deepseek-v4-flash",
          },
        }),
      );
      expect(model).toBe("deepseek-v4-flash");
      // The provider reports the configured id, not the literal "openai_compatible".
      expect(provider.id).toBe("deepseek");
    });

    it("treats a bare baseUrl (no type) as openai_compatible", () => {
      const { model } = createProvider(
        cfg("groq", { groq: { baseUrl: "https://api.groq.com/openai/v1", defaultModel: "llama-3.3-70b" } }),
      );
      expect(model).toBe("llama-3.3-70b");
    });

    it("lets a registered factory id win over an inline type", () => {
      // openai_compatible has a registered factory; the inline type must not shadow it.
      const { provider } = createProvider(
        cfg("openai_compatible", {
          openai_compatible: { type: "openai_compatible", baseUrl: "http://x/v1", defaultModel: "m" },
        }),
      );
      expect(provider.id).toBe("openai_compatible");
    });

    it("does NOT inline a config whose type names another backend — still errors toward plugins", () => {
      expect(() =>
        createProvider(cfg("anthropic", { anthropic: { type: "anthropic", defaultModel: "claude" } })),
      ).toThrow(/No provider factory registered for "anthropic"/);
    });

    it("requires a defaultModel for an inline openai_compatible id", () => {
      expect(() =>
        createProvider(
          cfg("deepseek", { deepseek: { type: "openai_compatible", baseUrl: "https://api.deepseek.com" } }),
        ),
      ).toThrow(/providers\.deepseek requires a defaultModel/);
    });

    it("mentions the inline option in the unknown-provider error", () => {
      expect(() => createProvider(cfg("mistral", { mistral: { defaultModel: "m" } }))).toThrow(
        /type: openai_compatible/,
      );
    });
  });
});
