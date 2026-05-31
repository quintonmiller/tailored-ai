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

providerFactoryRegistry.register("openai", (config) => {
  const cfg = config.providers.openai;
  if (!cfg) throw new Error("providers.openai not configured");
  return {
    provider: new OpenAIProvider(cfg.apiKey, cfg.baseUrl),
    model: cfg.defaultModel,
  };
});

providerFactoryRegistry.register("openai_compatible", (config) => {
  const cfg = config.providers.openai_compatible;
  if (!cfg) throw new Error("providers.openai_compatible not configured");
  return {
    provider: new OpenAIProvider(cfg.apiKey, cfg.baseUrl, {
      id: "openai_compatible",
      name: cfg.name ?? "OpenAI-compatible",
    }),
    model: cfg.defaultModel,
  };
});

providerFactoryRegistry.register("anthropic", (config) => {
  const cfg = config.providers.anthropic;
  if (!cfg) throw new Error("providers.anthropic not configured");
  return {
    provider: new AnthropicProvider(cfg.apiKey, cfg.baseUrl),
    model: cfg.defaultModel,
  };
});

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
