/**
 * @tailored-ai/provider-openrouter
 *
 * OpenRouter (https://openrouter.ai) speaks the OpenAI wire format, so this
 * plugin is a thin configuration of core's exported `OpenAIProvider`: the
 * right base URL, required API key, and the `openrouter` id. Chat, streaming
 * (`chatStream`), and model discovery (`listModels` — OpenRouter's full
 * catalog) all come from the shared implementation.
 *
 * Add to `config.yaml`:
 *
 *     plugins:
 *       - "@tailored-ai/provider-openrouter"
 *     providers:
 *       openrouter:
 *         apiKey: "${OPENROUTER_API_KEY}"
 *         defaultModel: "anthropic/claude-haiku-4.5"
 *     agent:
 *       defaultProvider: openrouter
 *
 * Attribution headers (`HTTP-Referer` / `X-Title`, used for OpenRouter's app
 * rankings) need the extraHeaders seam tracked in #234 and will follow.
 */
import type { AgentConfig, Plugin, PluginMeta, ThinkingLevel, ThinkingMapper } from "@tailored-ai/core";
import { isThinkingLevel, OpenAIProvider } from "@tailored-ai/core";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * OpenRouter's unified `reasoning` param (#254): `low`/`medium`/`high` map to
 * `reasoning.effort`; `off` disables it; `auto` adds nothing (the upstream
 * model's default). OpenRouter normalizes this across vendors, and reasoning
 * text comes back on `message.reasoning` / `delta.reasoning`, which core's
 * OpenAIProvider captures.
 */
const openrouterThinkingMap: ThinkingMapper = (level) => {
  if (level === "auto") return undefined;
  if (level === "off") return { reasoning: { enabled: false } };
  return { reasoning: { effort: level } };
};

/** Config bag read from `providers.openrouter` — owned by this plugin. */
export interface OpenRouterConfig {
  apiKey?: string;
  defaultModel?: string;
  /** Override for proxies/self-hosted gateways. Defaults to the public OpenRouter endpoint. */
  baseUrl?: string;
  /**
   * Default reasoning effort (#254): off | auto | low | medium | high. Sent as
   * OpenRouter's `reasoning` param; a per-agent `thinking` overrides it per call.
   */
  thinking?: ThinkingLevel;
}

/** Build the configured provider — exported for tests and direct use. */
export function createOpenRouterProvider(cfg: OpenRouterConfig): OpenAIProvider {
  return new OpenAIProvider(cfg.apiKey, cfg.baseUrl ?? OPENROUTER_BASE_URL, {
    id: "openrouter",
    name: "OpenRouter",
    thinkingMap: openrouterThinkingMap,
    defaultThinking: isThinkingLevel(cfg.thinking) ? cfg.thinking : undefined,
  });
}

export const meta: PluginMeta = {
  name: "OpenRouter provider",
  description: "One API key for hundreds of models across vendors, via OpenRouter's OpenAI-compatible API.",
  registers: [{ kind: "provider", id: "openrouter", configKey: "providers.openrouter" }],
};

/** Plugin-owned config checks — the shape lives here, not in core (#229). */
export function validateConfig(config: AgentConfig): string[] {
  const cfg = config.providers.openrouter as OpenRouterConfig | undefined;
  if (!cfg) return [];
  const warnings: string[] = [];
  if (!cfg.apiKey) {
    warnings.push('providers.openrouter is configured but apiKey is missing — set it to "${OPENROUTER_API_KEY}"');
  }
  if (!cfg.defaultModel) {
    warnings.push(
      'providers.openrouter is configured but defaultModel is missing — an OpenRouter model id, e.g. "anthropic/claude-haiku-4.5"',
    );
  }
  if (cfg.thinking !== undefined && !isThinkingLevel(cfg.thinking)) {
    warnings.push("providers.openrouter.thinking must be one of: off, auto, low, medium, high");
  }
  return warnings;
}

const plugin: Plugin = (ctx) => {
  ctx.providers.register("openrouter", (config) => {
    const cfg = config.providers.openrouter as OpenRouterConfig | undefined;
    if (!cfg) throw new Error("providers.openrouter not configured");
    if (!cfg.apiKey) throw new Error("providers.openrouter requires an apiKey (https://openrouter.ai/keys)");
    if (!cfg.defaultModel) {
      throw new Error(
        'providers.openrouter requires a defaultModel — an OpenRouter model id, e.g. "anthropic/claude-haiku-4.5"',
      );
    }
    return { provider: createOpenRouterProvider(cfg), model: cfg.defaultModel };
  });
};

export default plugin;
