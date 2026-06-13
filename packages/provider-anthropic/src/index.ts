/**
 * @tailored-ai/provider-anthropic
 *
 * Full-featured Anthropic Messages API provider. Registers the `anthropic`
 * id — the provider that used to be a core built-in (#236). Existing
 * `providers.anthropic` config keeps working and gains prompt caching,
 * version/beta headers, and extra-field passthrough. On cores that still
 * ship the minimal built-in, this plugin supersedes it (one-line registry
 * notice at startup).
 *
 * Add to `config.yaml`:
 *
 *     plugins:
 *       - "@tailored-ai/provider-anthropic"
 *     providers:
 *       anthropic:
 *         apiKey: "${ANTHROPIC_API_KEY}"
 *         defaultModel: "claude-haiku-4-5"
 *         promptCaching: true          # optional — cache system prompt + tools
 *         betas: []                    # optional — anthropic-beta header values
 *     agent:
 *       defaultProvider: anthropic
 */
import type { AgentConfig, Plugin, PluginMeta, ThinkingLevel } from "@tailored-ai/core";
import { isThinkingLevel } from "@tailored-ai/core";
import { AnthropicMessagesProvider } from "./provider.js";

export {
  AnthropicMessagesProvider,
  type AnthropicMessagesProviderOptions,
  mapStopReason,
  parseApiResponse,
  toApiMessages,
  toApiTools,
} from "./provider.js";

/** Config bag read from `providers.anthropic` — owned by this plugin. */
export interface AnthropicConfig {
  apiKey?: string;
  defaultModel?: string;
  baseUrl?: string;
  version?: string;
  betas?: string[];
  defaultMaxTokens?: number;
  promptCaching?: boolean;
  /** Default extended-thinking effort (#254): off | auto | low | medium | high. */
  thinking?: ThinkingLevel;
}

export const meta: PluginMeta = {
  name: "Anthropic provider",
  description: "Claude models via the Messages API — prompt caching, beta headers, streaming.",
  registers: [{ kind: "provider", id: "anthropic", configKey: "providers.anthropic" }],
};

/** Plugin-owned config checks — the shape lives here, not in core (#229). */
export function validateConfig(config: AgentConfig): string[] {
  const cfg = config.providers.anthropic as AnthropicConfig | undefined;
  if (!cfg) return [];
  const warnings: string[] = [];
  if (!cfg.apiKey) {
    warnings.push('providers.anthropic is configured but apiKey is missing — set it to "${ANTHROPIC_API_KEY}"');
  }
  if (!cfg.defaultModel) {
    warnings.push('providers.anthropic is configured but defaultModel is missing — e.g. "claude-haiku-4-5"');
  }
  if (cfg.thinking !== undefined && !isThinkingLevel(cfg.thinking)) {
    warnings.push("providers.anthropic.thinking must be one of: off, auto, low, medium, high");
  }
  return warnings;
}

const plugin: Plugin = (ctx) => {
  ctx.providers.register("anthropic", (config) => {
    const cfg = config.providers.anthropic as AnthropicConfig | undefined;
    if (!cfg) throw new Error("providers.anthropic not configured");
    if (!cfg.apiKey) throw new Error("providers.anthropic requires an apiKey (https://console.anthropic.com)");
    if (!cfg.defaultModel) {
      throw new Error('providers.anthropic requires a defaultModel — e.g. "claude-haiku-4-5"');
    }
    return {
      provider: new AnthropicMessagesProvider({
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        version: cfg.version,
        betas: cfg.betas,
        defaultMaxTokens: cfg.defaultMaxTokens,
        promptCaching: cfg.promptCaching,
        defaultThinking: isThinkingLevel(cfg.thinking) ? cfg.thinking : undefined,
      }),
      model: cfg.defaultModel,
    };
  });
};

export default plugin;
