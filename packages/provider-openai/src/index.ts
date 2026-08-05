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
import type { AgentConfig, AIProvider, Plugin, PluginMeta, ThinkingLevel } from "@tailored-ai/core";
import { isThinkingLevel } from "@tailored-ai/core";
import { OpenAIChatProvider } from "./provider.js";
import { OpenAIResponsesProvider } from "./responses.js";
import { OpenAIRouterProvider } from "./router.js";

export {
  isReasoningModel,
  OpenAIChatProvider,
  type OpenAIChatProviderOptions,
  toApiMessages,
  toApiTools,
} from "./provider.js";
export {
  OpenAIResponsesProvider,
  type OpenAIResponsesProviderOptions,
  toResponsesInput,
  toResponsesTools,
} from "./responses.js";
export { type OpenAIRouterOptions, OpenAIRouterProvider } from "./router.js";

/** Which OpenAI endpoint to talk to. */
export type OpenAIApi = "auto" | "chat" | "responses";

/** Config bag read from `providers.openai` — owned by this plugin. */
export interface OpenAIConfig {
  apiKey?: string;
  defaultModel?: string;
  baseUrl?: string;
  organization?: string;
  project?: string;
  reasoningModels?: string[];
  /** Default reasoning effort (#254): off | auto | low | medium | high → `reasoning_effort`. */
  thinking?: ThinkingLevel;
  /**
   * Endpoint selection (#378). `auto` (default) sends models that need
   * `/v1/responses` there and everything else to `/v1/chat/completions`;
   * `chat` and `responses` pin it.
   */
  api?: OpenAIApi;
  /** Extra model-id prefixes to route to `/v1/responses` under `api: auto`. */
  responsesModels?: string[];
  /** Ask for a readable reasoning summary on `/v1/responses`. Default `auto`. */
  reasoningSummary?: "auto" | "concise" | "detailed" | "off";
  /** Let OpenAI retain responses server-side. Default false. */
  store?: boolean;
}

/**
 * Models `/v1/chat/completions` cannot serve properly, measured 2026-08-05:
 * the 5.4+ generations reject function tools alongside any reasoning effort,
 * and codex is not served there at all. Routing them to `/v1/responses` is the
 * only way to get reasoning and tool calls in the same turn.
 *
 * A prefix list is the wrong shape for deciding *request* fields — it rots, and
 * #377 is what that costs. It is the right shape here because being wrong is
 * cheap in one direction: `/v1/responses` accepts every current model, so a
 * false positive still works, while a false negative just leaves a model where
 * it already was. `responsesModels` extends it without a release.
 */
export function needsResponsesApi(model: string, extraPrefixes: string[] = []): boolean {
  const id = model.toLowerCase();
  if (id.includes("codex")) return true;
  if (/^gpt-5\.(4|5|6)/.test(id)) return true;
  return extraPrefixes.some((p) => id.startsWith(p.toLowerCase()));
}

/** Whether `auto` may route to `/v1/responses` for this deployment. */
function isOfficialOpenAI(baseUrl: string | undefined): boolean {
  if (!baseUrl) return true;
  try {
    return new URL(baseUrl).hostname === "api.openai.com";
  } catch {
    return false;
  }
}

export const meta: PluginMeta = {
  name: "OpenAI provider",
  description:
    "GPT and o-series models via chat completions or the Responses API — reasoning with tools, org/project headers, streaming.",
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
  if (cfg.thinking !== undefined && !isThinkingLevel(cfg.thinking)) {
    warnings.push("providers.openai.thinking must be one of: off, auto, low, medium, high");
  }
  if (cfg.api !== undefined && !["auto", "chat", "responses"].includes(cfg.api)) {
    warnings.push("providers.openai.api must be one of: auto, chat, responses");
  }
  if (cfg.api === "auto" && cfg.baseUrl && !isOfficialOpenAI(cfg.baseUrl)) {
    // Silently downgrading would look like the setting was ignored, which is
    // exactly the class of bug this repo keeps finding: config that parses and
    // is never read.
    warnings.push(
      `providers.openai.api: auto only routes to /v1/responses on api.openai.com — with baseUrl ${cfg.baseUrl} every model uses chat completions. Set api: responses to force it.`,
    );
  }
  return warnings;
}

/** Endpoint choice for one model, given config. Exported for testing. */
export function selectApi(cfg: OpenAIConfig, model: string): "chat" | "responses" {
  const mode = cfg.api ?? "auto";
  if (mode === "chat" || mode === "responses") return mode;
  if (!isOfficialOpenAI(cfg.baseUrl)) return "chat";
  return needsResponsesApi(model, cfg.responsesModels) ? "responses" : "chat";
}

const plugin: Plugin = (ctx) => {
  ctx.providers.register("openai", (config) => {
    const cfg = config.providers.openai as OpenAIConfig | undefined;
    if (!cfg) throw new Error("providers.openai not configured");
    if (!cfg.apiKey) throw new Error("providers.openai requires an apiKey (https://platform.openai.com/api-keys)");
    if (!cfg.defaultModel) {
      throw new Error('providers.openai requires a defaultModel — e.g. "gpt-5-mini"');
    }
    const thinking = isThinkingLevel(cfg.thinking) ? cfg.thinking : undefined;
    const shared = {
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      organization: cfg.organization,
      project: cfg.project,
      reasoningModels: cfg.reasoningModels,
      defaultThinking: thinking,
    };

    const chat = new OpenAIChatProvider(shared);

    // `chat` pinned means the Responses provider can never be reached, so
    // building it would only add a way to be wrong.
    const provider: AIProvider =
      cfg.api === "chat"
        ? chat
        : new OpenAIRouterProvider({
            chat,
            responses: new OpenAIResponsesProvider({
              ...shared,
              reasoningSummary: cfg.reasoningSummary,
              store: cfg.store,
            }),
            select: (model) => selectApi(cfg, model),
          });

    return { provider, model: cfg.defaultModel };
  });
};

export default plugin;
