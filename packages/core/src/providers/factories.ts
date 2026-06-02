import type { AgentConfig } from "../config.js";
import type { PluginContext } from "../plugin-context.js";
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

const openaiFactory: ProviderFactory = (config) => {
  const cfg = config.providers.openai;
  if (!cfg) throw new Error("providers.openai not configured");
  return {
    provider: new OpenAIProvider(cfg.apiKey, cfg.baseUrl),
    model: cfg.defaultModel,
  };
};

const openaiCompatibleFactory: ProviderFactory = (config) => {
  const cfg = config.providers.openai_compatible;
  if (!cfg) throw new Error("providers.openai_compatible not configured");
  return {
    provider: new OpenAIProvider(cfg.apiKey, cfg.baseUrl, {
      id: "openai_compatible",
      name: cfg.name ?? "OpenAI-compatible",
    }),
    model: cfg.defaultModel,
  };
};

const anthropicFactory: ProviderFactory = (config) => {
  const cfg = config.providers.anthropic;
  if (!cfg) throw new Error("providers.anthropic not configured");
  return {
    provider: new AnthropicProvider(cfg.apiKey, cfg.baseUrl),
    model: cfg.defaultModel,
  };
};

const openaiCompatibleEmbeddingFactory: EmbeddingFactory = (config) => {
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
};

/**
 * Seed the built-in provider + embedding factories into the given context.
 * Called by {@link registerCoreBuiltins} during AgentRuntime construction.
 */
export function registerBuiltinProviders(ctx: PluginContext): void {
  ctx.providers.register("openai", openaiFactory);
  ctx.providers.register("openai_compatible", openaiCompatibleFactory);
  ctx.providers.register("anthropic", anthropicFactory);
  // OpenAI-compatible /v1/embeddings (vLLM, LM Studio, Ollama). Plugins
  // can register additional embedding factories (qdrant-fastembed, voyage,
  // cohere, …) via ctx.embeddings.register.
  ctx.embeddings.register("openai_compatible", openaiCompatibleEmbeddingFactory);
}
