import type { AgentConfig } from "../config.js";
import { Registry } from "../registry.js";
import { AnthropicProvider } from "./anthropic.js";
import type { EmbeddingProvider } from "./embedding.js";
import type { AIProvider } from "./interface.js";
import { OpenAIProvider } from "./openai.js";
import { OpenAICompatibleEmbeddingProvider } from "./openai-embedding.js";

export interface ProviderFactoryResult {
  provider: AIProvider;
  model: string;
}

export type ProviderFactory = (config: AgentConfig) => ProviderFactoryResult;

/**
 * Build an embedding provider from config. Implementations decide whether
 * embeddings are enabled (typically by inspecting `config.memory?.embeddings`)
 * and return undefined when disabled.
 */
export type EmbeddingFactory = (config: AgentConfig) => EmbeddingProvider | undefined;

export const providerFactoryRegistry = new Registry<ProviderFactory>("provider");
export const embeddingFactoryRegistry = new Registry<EmbeddingFactory>("embedding");

export function registerProviderFactory(id: string, factory: ProviderFactory): void {
  providerFactoryRegistry.register(id, factory);
}

export function registerEmbeddingFactory(id: string, factory: EmbeddingFactory): void {
  embeddingFactoryRegistry.register(id, factory);
}

// Built-in providers register on module load so any package that imports
// @tailored-ai/core gets them automatically.

// Built-ins read their settings from the backend-opaque `providers.<id>`
// bag — exactly how a plugin provider would — so core privileges no
// built-in. `requireModel` enforces the one field every provider needs.

providerFactoryRegistry.register("openai", (config) => {
  const cfg = config.providers.openai;
  if (!cfg) throw new Error("providers.openai not configured");
  return {
    provider: new OpenAIProvider(asString(cfg.apiKey), asString(cfg.baseUrl)),
    model: requireModel(cfg, "openai"),
  };
});

providerFactoryRegistry.register("openai_compatible", (config) => {
  const cfg = config.providers.openai_compatible;
  if (!cfg) throw new Error("providers.openai_compatible not configured");
  return {
    provider: new OpenAIProvider(asString(cfg.apiKey), asString(cfg.baseUrl), {
      id: "openai_compatible",
      name: asString(cfg.name) ?? "OpenAI-compatible",
    }),
    model: requireModel(cfg, "openai_compatible"),
  };
});

providerFactoryRegistry.register("anthropic", (config) => {
  const cfg = config.providers.anthropic;
  if (!cfg) throw new Error("providers.anthropic not configured");
  return {
    provider: new AnthropicProvider(asString(cfg.apiKey) ?? "", asString(cfg.baseUrl)),
    model: requireModel(cfg, "anthropic"),
  };
});

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function requireModel(cfg: Record<string, unknown>, id: string): string {
  const model = asString(cfg.defaultModel);
  if (!model) throw new Error(`providers.${id} requires a defaultModel`);
  return model;
}

// Embedding built-in: an OpenAI-compatible /v1/embeddings endpoint (also
// covers vLLM, LM Studio, Ollama). Plugin authors can register additional
// embedding factories (e.g. "qdrant-fastembed", "voyage", "cohere") via
// registerEmbeddingFactory.
embeddingFactoryRegistry.register("openai_compatible", (config) => {
  const cfg = config.memory?.embeddings;
  if (!cfg?.enabled) return undefined;
  if (!cfg.baseUrl || !cfg.model) {
    console.warn("[providers] memory.embeddings.enabled is true but baseUrl/model missing — disabling embeddings");
    return undefined;
  }
  return new OpenAICompatibleEmbeddingProvider({
    baseUrl: cfg.baseUrl,
    defaultModel: cfg.model,
    apiKey: cfg.apiKey,
    dim: cfg.dim,
  });
});
