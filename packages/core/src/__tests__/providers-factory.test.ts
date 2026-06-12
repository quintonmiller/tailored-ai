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
});
