/**
 * @tailored-ai/provider-deepseek
 *
 * DeepSeek (https://platform.deepseek.com) speaks the OpenAI wire format, so
 * this plugin builds on core's exported `OpenAIProvider`: the right base URL,
 * required API key, and the `deepseek` id. Chat, streaming (`chatStream`),
 * tool calling, and model discovery (`listModels`) all come from the shared
 * implementation.
 *
 * On top of that it adds DeepSeek's one non-standard knob: the V4 hybrid models
 * (`deepseek-v4-flash`, `deepseek-v4-pro`) reason before answering by default,
 * and the thinking pass is toggled per request with `thinking: { type }`. The
 * `thinking` config option injects that field into every call.
 *
 * Models (verified against the live API, 2026-06):
 *   - `deepseek-v4-flash` — V4 hybrid, lower-latency tier. Tool calling works in
 *   - `deepseek-v4-pro`     both modes; in thinking mode it emits `reasoning_content`
 *                           (which TAI drops) and needs a generous `maxTokens`.
 *   - `deepseek-chat` / `deepseek-reasoner` — non-thinking / thinking aliases of
 *                           `deepseek-v4-flash`. Deprecated 2026-07-24; prefer the
 *                           V4 id with `thinking` instead.
 *
 * The durable "snappy, reliable tool calls" setup (what `deepseek-chat` gave) is
 * `deepseek-v4-flash` with `thinking: false`.
 *
 * Add to `config.yaml`:
 *
 *     plugins:
 *       - "@tailored-ai/provider-deepseek"
 *     providers:
 *       deepseek:
 *         apiKey: "${DEEPSEEK_API_KEY}"
 *         defaultModel: "deepseek-v4-flash"
 *         thinking: false        # non-thinking; omit for the model's native default
 *     agent:
 *       defaultProvider: deepseek
 */
import type { AgentConfig, ChatParams, ChatResponse, ChatStreamEvent, Plugin, PluginMeta } from "@tailored-ai/core";
import { OpenAIProvider } from "@tailored-ai/core";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

/** Config bag read from `providers.deepseek` — owned by this plugin. */
export interface DeepSeekConfig {
  apiKey?: string;
  defaultModel?: string;
  /** Override for proxies/self-hosted gateways. Defaults to the public DeepSeek endpoint. */
  baseUrl?: string;
  /**
   * Thinking mode for the V4 hybrid models (`deepseek-v4-flash`/`-pro`).
   * `false` → non-thinking: snappy, no reasoning tokens, reliable tool calls —
   * the `deepseek-chat` experience, but durable. `true` → thinking: reasons
   * before answering (give it a generous `maxTokens`). Omit to leave each
   * model on its native default (the V4 models think by default). Sent as
   * `thinking: { type: "enabled" | "disabled" }` on every request.
   */
  thinking?: boolean;
}

/**
 * `OpenAIProvider` plus DeepSeek's `thinking` toggle. When `thinking` is set,
 * every chat/stream request carries `thinking: { type }`; a per-call `extra`
 * still wins, so the loop can override it. Everything else (auth, streaming,
 * tool calls, `listModels`) is inherited unchanged.
 */
class DeepSeekProvider extends OpenAIProvider {
  private readonly thinkingExtra?: Record<string, unknown>;

  constructor(cfg: DeepSeekConfig) {
    super(cfg.apiKey, cfg.baseUrl ?? DEEPSEEK_BASE_URL, { id: "deepseek", name: "DeepSeek" });
    if (cfg.thinking !== undefined) {
      this.thinkingExtra = { thinking: { type: cfg.thinking ? "enabled" : "disabled" } };
    }
  }

  private withThinking(params: ChatParams): ChatParams {
    if (!this.thinkingExtra) return params;
    return { ...params, extra: { ...this.thinkingExtra, ...params.extra } };
  }

  chat(params: ChatParams): Promise<ChatResponse> {
    return super.chat(this.withThinking(params));
  }

  chatStream(params: ChatParams): AsyncIterable<ChatStreamEvent> {
    return super.chatStream(this.withThinking(params));
  }
}

/** Build the configured provider — exported for tests and direct use. */
export function createDeepSeekProvider(cfg: DeepSeekConfig): OpenAIProvider {
  return new DeepSeekProvider(cfg);
}

export const meta: PluginMeta = {
  name: "DeepSeek provider",
  description: "DeepSeek V4 hybrid models (flash, pro) with a thinking-mode toggle, via the OpenAI-compatible API.",
  registers: [{ kind: "provider", id: "deepseek", configKey: "providers.deepseek" }],
};

/** Plugin-owned config checks — the shape lives here, not in core (#229). */
export function validateConfig(config: AgentConfig): string[] {
  const cfg = config.providers.deepseek as DeepSeekConfig | undefined;
  if (!cfg) return [];
  const warnings: string[] = [];
  if (!cfg.apiKey) {
    warnings.push('providers.deepseek is configured but apiKey is missing — set it to "${DEEPSEEK_API_KEY}"');
  }
  if (!cfg.defaultModel) {
    warnings.push('providers.deepseek is configured but defaultModel is missing — e.g. "deepseek-v4-flash"');
  }
  if (cfg.thinking !== undefined && typeof cfg.thinking !== "boolean") {
    warnings.push("providers.deepseek.thinking must be a boolean (true = thinking, false = non-thinking)");
  }
  return warnings;
}

const plugin: Plugin = (ctx) => {
  ctx.providers.register("deepseek", (config) => {
    const cfg = config.providers.deepseek as DeepSeekConfig | undefined;
    if (!cfg) throw new Error("providers.deepseek not configured");
    if (!cfg.apiKey) throw new Error("providers.deepseek requires an apiKey (https://platform.deepseek.com/api_keys)");
    if (!cfg.defaultModel) {
      throw new Error('providers.deepseek requires a defaultModel — e.g. "deepseek-v4-flash"');
    }
    return { provider: createDeepSeekProvider(cfg), model: cfg.defaultModel };
  });
};

export default plugin;
