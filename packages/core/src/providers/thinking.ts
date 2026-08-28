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
 * The effort rungs a template-side `reasoning_effort` understands. Deliberately
 * *not* the same list as {@link THINKING_LEVELS}: templates in this family
 * accept `low`/`medium`/`xhigh` and raise on anything else, so core's `high`
 * has to land on the top rung by name rather than by hope.
 */
const TEMPLATE_EFFORT: Partial<Record<ThinkingLevel, string>> = {
  low: "low",
  medium: "medium",
  high: "xhigh",
};

/**
 * vLLM / Qwen template toggle *with* effort, for templates that read
 * `chat_template_kwargs.reasoning_effort` alongside `enable_thinking`.
 *
 * Separate from {@link enableThinkingTemplateMap} rather than folded into it:
 * a template that doesn't declare the kwarg either ignores it or raises, and
 * the ones that do raise reject core's `high` outright (they accept `xhigh`).
 * Sending effort to every vLLM endpoint would therefore break the endpoints
 * that work today, so this is opt-in per provider — `thinkingDialect: vllm_effort`.
 *
 * Without it a model whose template defaults to its *highest* effort can only
 * be asked for that default, which is a real cost: measured on Qwen3.8, the
 * top rung spends roughly twice the output tokens of `medium`.
 */
export const effortTemplateMap: ThinkingMapper = (level) => {
  if (level === "auto") return undefined;
  if (level === "off") return { chat_template_kwargs: { enable_thinking: false } };
  const effort = TEMPLATE_EFFORT[level];
  return { chat_template_kwargs: { enable_thinking: true, ...(effort ? { reasoning_effort: effort } : {}) } };
};

/**
 * Generic OpenAI-compatible dialects core's built-in `openai_compatible`
 * provider can select via `providers.<id>.thinkingDialect`. These are
 * wire-protocol conventions core legitimately owns — not vendor plugins.
 */
export const OPENAI_COMPATIBLE_THINKING_DIALECTS: Record<string, ThinkingMapper | undefined> = {
  openai: reasoningEffortThinkingMap,
  vllm: enableThinkingTemplateMap,
  vllm_effort: effortTemplateMap,
  none: undefined,
};
