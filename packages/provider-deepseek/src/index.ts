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
import type { AgentConfig, Plugin, PluginMeta, ThinkingLevel, ThinkingMapper } from "@tailored-ai/core";
import { isThinkingLevel, OpenAIProvider } from "@tailored-ai/core";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

/**
 * DeepSeek's thinking knob (#254): the V4 hybrids accept
 * `thinking: { type: "enabled" | "disabled" }` and have no effort granularity,
 * so any level except `off` enables thinking. `auto` adds nothing — the V4
 * models think by default, so we leave the request untouched.
 */
const deepseekThinkingMap: ThinkingMapper = (level) => {
  if (level === "auto") return undefined;
  return { thinking: { type: level === "off" ? "disabled" : "enabled" } };
};

/**
 * Resolve the per-provider default level from config. Legacy boolean form is
 * preserved: `true` → enabled (mapped via "high"), `false` → disabled ("off").
 * A {@link ThinkingLevel} string is used as-is; undefined leaves the model on
 * its native default.
 */
function resolveDefaultThinking(thinking: boolean | ThinkingLevel | undefined): ThinkingLevel | undefined {
  if (thinking === undefined) return undefined;
  if (typeof thinking === "boolean") return thinking ? "high" : "off";
  return thinking;
}

/** Config bag read from `providers.deepseek` — owned by this plugin. */
export interface DeepSeekConfig {
  apiKey?: string;
  defaultModel?: string;
  /** Override for proxies/self-hosted gateways. Defaults to the public DeepSeek endpoint. */
  baseUrl?: string;
  /**
   * Default thinking mode for the V4 hybrid models (`deepseek-v4-flash`/`-pro`).
   * `false` → non-thinking: snappy, no reasoning tokens, reliable tool calls —
   * the `deepseek-chat` experience, but durable. `true` → thinking: reasons
   * before answering (give it a generous `maxTokens`). A {@link ThinkingLevel}
   * (`off`/`auto`/`low`/`medium`/`high`) works too — DeepSeek has no effort
   * granularity, so any non-`off` level enables thinking. Omit to leave each
   * model on its native default (the V4 models think by default). A per-agent
   * `thinking` (#254) overrides this default per call. Sent as
   * `thinking: { type: "enabled" | "disabled" }` on every request.
   */
  thinking?: boolean | ThinkingLevel;
}

/**
 * Build the configured provider — core's `OpenAIProvider` wired with DeepSeek's
 * base URL, id, and the thinking mapper (#254). Reasoning capture
 * (`reasoning_content`) is inherited from `OpenAIProvider`, and a per-call
 * `extra` still wins over the mapped `thinking` fragment. Exported for tests.
 */
export function createDeepSeekProvider(cfg: DeepSeekConfig): OpenAIProvider {
  return new OpenAIProvider(cfg.apiKey, cfg.baseUrl ?? DEEPSEEK_BASE_URL, {
    id: "deepseek",
    name: "DeepSeek",
    thinkingMap: deepseekThinkingMap,
    defaultThinking: resolveDefaultThinking(cfg.thinking),
  });
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
  if (cfg.thinking !== undefined && typeof cfg.thinking !== "boolean" && !isThinkingLevel(cfg.thinking)) {
    warnings.push(
      "providers.deepseek.thinking must be a boolean or one of: off, auto, low, medium, high (true = thinking, false = non-thinking)",
    );
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
