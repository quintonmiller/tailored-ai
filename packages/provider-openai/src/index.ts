/**
 * @tailored-ai/provider-openai
 *
 * Full-featured OpenAI provider. Registers the `openai` id — the provider
 * that used to be a core built-in (#236). Existing `providers.openai`
 * config keeps working and gains reasoning-model handling (o-series /
 * gpt-5 reject `temperature` and `max_tokens`), org/project headers, and
 * extra-field passthrough. On cores that still ship the minimal built-in,
 * this plugin supersedes it (one-line registry notice at startup).
 *
 * Add to `config.yaml`:
 *
 *     plugins:
 *       - "@tailored-ai/provider-openai"
 *     providers:
 *       openai:
 *         apiKey: "${OPENAI_API_KEY}"
 *         defaultModel: "gpt-5-mini"
 *     agent:
 *       defaultProvider: openai
 */
import type { AgentConfig, Plugin, PluginMeta } from "@tailored-ai/core";
import { OpenAIChatProvider } from "./provider.js";

export {
  isReasoningModel,
  OpenAIChatProvider,
  type OpenAIChatProviderOptions,
  toApiMessages,
  toApiTools,
} from "./provider.js";

/** Config bag read from `providers.openai` — owned by this plugin. */
export interface OpenAIConfig {
  apiKey?: string;
  defaultModel?: string;
  baseUrl?: string;
  organization?: string;
  project?: string;
  reasoningModels?: string[];
}

export const meta: PluginMeta = {
  name: "OpenAI provider",
  description:
    "GPT and o-series models via chat completions — reasoning-model handling, org/project headers, streaming.",
  registers: [{ kind: "provider", id: "openai", configKey: "providers.openai" }],
};

/** Plugin-owned config checks — the shape lives here, not in core (#229). */
export function validateConfig(config: AgentConfig): string[] {
  const cfg = config.providers.openai as OpenAIConfig | undefined;
  if (!cfg) return [];
  const warnings: string[] = [];
  if (!cfg.apiKey) {
    warnings.push('providers.openai is configured but apiKey is missing — set it to "${OPENAI_API_KEY}"');
  }
  if (!cfg.defaultModel) {
    warnings.push('providers.openai is configured but defaultModel is missing — e.g. "gpt-5-mini"');
  }
  return warnings;
}

const plugin: Plugin = (ctx) => {
  ctx.providers.register("openai", (config) => {
    const cfg = config.providers.openai as OpenAIConfig | undefined;
    if (!cfg) throw new Error("providers.openai not configured");
    if (!cfg.apiKey) throw new Error("providers.openai requires an apiKey (https://platform.openai.com/api-keys)");
    if (!cfg.defaultModel) {
      throw new Error('providers.openai requires a defaultModel — e.g. "gpt-5-mini"');
    }
    return {
      provider: new OpenAIChatProvider({
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        organization: cfg.organization,
        project: cfg.project,
        reasoningModels: cfg.reasoningModels,
      }),
      model: cfg.defaultModel,
    };
  });
};

export default plugin;
