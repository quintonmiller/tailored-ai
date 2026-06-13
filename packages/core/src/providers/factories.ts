import type { AgentConfig } from "../config.js";
import { Registry } from "../registry.js";
import type { EmbeddingProvider } from "./embedding.js";
import type { AIProvider } from "./interface.js";
import { OpenAIProvider } from "./openai.js";
import { OpenAICompatibleEmbeddingProvider } from "./openai-embedding.js";
import { isThinkingLevel, OPENAI_COMPATIBLE_THINKING_DIALECTS } from "./thinking.js";

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

/**
 * Build core's {@link OpenAIProvider} from a `providers.<id>` options bag.
 * Shared by the registered `openai_compatible` factory and
 * {@link createProvider}'s inline fallback, so every OpenAI-wire endpoint —
 * whatever id it's configured under — gets an identical provider that reads
 * `baseUrl` / `defaultModel` / `apiKey` / `name`.
 */
export function buildOpenAICompatibleProvider(
  cfg: Record<string, unknown> | undefined,
  id: string,
): ProviderFactoryResult {
  if (!cfg) throw new Error(`providers.${id} not configured`);
  // Reasoning control (#254): an optional default level plus a dialect that
  // picks one of core's generic OpenAI-wire mappers. Vendor budget policy
  // stays in provider plugins; here we only expose protocol conventions.
  const dialect = asString(cfg.thinkingDialect) ?? "none";
  const thinkingMap = OPENAI_COMPATIBLE_THINKING_DIALECTS[dialect];
  const defaultThinking = isThinkingLevel(cfg.thinking) ? cfg.thinking : undefined;
  return {
    provider: new OpenAIProvider(asString(cfg.apiKey), asString(cfg.baseUrl), {
      id,
      name: asString(cfg.name) ?? "OpenAI-compatible",
      thinkingMap,
      defaultThinking,
    }),
    model: requireModel(cfg, id),
  };
}

/**
 * True when a `providers.<id>` bag should be served by the built-in
 * {@link OpenAIProvider} even though no factory is registered under `id`:
 * it declares `type: "openai_compatible"`, or (convenience) carries a
 * `baseUrl` with no other `type`. This lets several OpenAI-wire endpoints
 * coexist under distinct ids — local vLLM + DeepSeek + Groq + … — without a
 * per-vendor plugin, while a registered factory id still wins (see #253 and
 * {@link createProvider}). A `type` naming some other backend opts out.
 */
export function isInlineOpenAICompatible(cfg: Record<string, unknown> | undefined): boolean {
  if (!cfg) return false;
  if (typeof cfg.type === "string") return cfg.type === "openai_compatible";
  return typeof cfg.baseUrl === "string";
}

// The one built-in provider registers on module load so any package that
// imports @tailored-ai/core gets it automatically. It reads its settings
// from the backend-opaque `providers.<id>` bag — exactly how a plugin
// provider would — so core privileges no built-in. Hosted vendors live in
// plugin packages: @tailored-ai/provider-openai, provider-anthropic,
// provider-openrouter, provider-bedrock (#236). The same OpenAIProvider is
// also reachable under any id via `type: openai_compatible` (#253) without
// going through this named registration.

providerFactoryRegistry.register("openai_compatible", (config) =>
  buildOpenAICompatibleProvider(config.providers.openai_compatible, "openai_compatible"),
);

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
