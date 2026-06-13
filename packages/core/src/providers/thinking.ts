import type { ChatParams, ThinkingLevel } from "./interface.js";

/**
 * Provider-agnostic reasoning control (#254). The agent loop sets a
 * {@link ThinkingLevel} on every chat call; each provider maps it to its own
 * wire format. Core ships only the *mechanism* (this seam) plus the generic,
 * protocol-level mappers below — vendor-specific budget/effort policy lives in
 * the corresponding provider plugin, so core never learns a plugin's name.
 *
 * A mapper returns the request-body fragment to merge for `level`, or
 * `undefined` to add nothing (e.g. `off`/`auto` for effort-style APIs that
 * have no explicit "let the model decide" knob).
 */
export type ThinkingMapper = (level: ThinkingLevel, params: ChatParams) => Record<string, unknown> | undefined;

/** Every {@link ThinkingLevel}, for config validation in providers. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "auto", "low", "medium", "high"] as const;

/** Type guard: is `value` a {@link ThinkingLevel}? */
export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * OpenAI's `reasoning_effort` knob (o-series, gpt-5): `low`/`medium`/`high`
 * map straight through; `off`/`auto` add nothing (the API has no off switch —
 * pick a non-reasoning model instead — and no explicit auto, which is its
 * default). The protocol convention OpenRouter and others also accept.
 */
export const reasoningEffortThinkingMap: ThinkingMapper = (level) => {
  if (level === "low" || level === "medium" || level === "high") {
    return { reasoning_effort: level };
  }
  return undefined;
};

/**
 * vLLM / Qwen template toggle: `chat_template_kwargs.enable_thinking`. `off`
 * disables thinking; `low`/`medium`/`high` enable it (the template has no
 * effort granularity); `auto` leaves the server on its template default.
 */
export const enableThinkingTemplateMap: ThinkingMapper = (level) => {
  if (level === "auto") return undefined;
  return { chat_template_kwargs: { enable_thinking: level !== "off" } };
};

/**
 * Generic OpenAI-compatible dialects core's built-in `openai_compatible`
 * provider can select via `providers.<id>.thinkingDialect`. These are
 * wire-protocol conventions core legitimately owns — not vendor plugins.
 */
export const OPENAI_COMPATIBLE_THINKING_DIALECTS: Record<string, ThinkingMapper | undefined> = {
  openai: reasoningEffortThinkingMap,
  vllm: enableThinkingTemplateMap,
  none: undefined,
};
