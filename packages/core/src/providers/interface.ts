import type { MessageContent } from "../content/types.js";

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  /**
   * What this turn says.
   *
   * A plain `string` still means exactly what it always did, so the text-only
   * path is unchanged at every construction site. The `MessageContent` arm
   * carries ordered parts when a turn includes media (docs/media-design.md).
   *
   * That arm is an **object, not a bare `ContentPart[]`**, and that is
   * load-bearing rather than stylistic: `string` and `Array` share `.length`,
   * `.slice`, `.indexOf` and `.includes`, so an array arm type-checks at every
   * existing read site and silently misbehaves. Use {@link messageText} where
   * you want the text projection, and say so at the call site.
   */
  content: string | MessageContent | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  /**
   * The model's reasoning/thinking trace for an assistant turn (#254), when
   * the provider emits one. Captured, persisted, and rendered, but NEVER sent
   * back to a provider — message→wire converters deliberately ignore it, since
   * some APIs 400 on a re-sent reasoning-only assistant turn.
   */
  reasoning?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Provider-agnostic reasoning/thinking effort (#254). Each provider maps it to
 * its own wire format (OpenAI `reasoning_effort`, Anthropic/Bedrock
 * `thinking`/`reasoning_config` budgets, DeepSeek `thinking:{type}`, vLLM
 * `chat_template_kwargs.enable_thinking`). `off` disables thinking; `auto`
 * leaves the model on its native default (providers without discrete effort
 * levels treat any non-`off` level as "enabled").
 */
export type ThinkingLevel = "off" | "auto" | "low" | "medium" | "high";

export interface ChatParams {
  model: string;
  messages: Message[];
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
  /**
   * Reasoning effort for this call (#254). Overrides a provider's configured
   * default. Providers that don't support reasoning ignore it.
   */
  thinking?: ThinkingLevel;
  /**
   * Opaque provider-specific request fields merged into the outgoing request
   * body (e.g. vLLM's `chat_template_kwargs`). Providers that build their own
   * request shape may ignore keys they don't understand. Wins over the mapped
   * {@link ChatParams.thinking} fragment when both target the same key.
   */
  extra?: Record<string, unknown>;
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * What one request cost.
 *
 * `cacheRead` and `cacheWrite` are **optional on purpose**. Only some vendors
 * report them, and requiring every provider to invent a number would be worse
 * than an honest absence — undefined means "this provider does not say", which
 * is different from zero.
 *
 * They are reported *alongside* `input`, not carved out of it. Vendors differ
 * on whether cached tokens are already counted in the input total (Anthropic
 * sums all three), so subtracting here would silently double-correct for some
 * providers. `input` keeps whatever the provider called input; these two add
 * detail rather than restating it.
 */
export interface TokenUsage {
  input: number;
  output: number;
  /** Tokens served from a prompt cache, when the provider reports it. */
  cacheRead?: number;
  /** Tokens written to a prompt cache, when the provider reports it. */
  cacheWrite?: number;
}

export interface ChatResponse {
  /**
   * What the model said. A `MessageContent` arm is reserved for models that
   * emit media as output; every provider shipping today returns a string or
   * null. See the note on {@link Message.content} for why the arm is an object.
   */
  content: string | MessageContent | null;
  toolCalls?: ToolCall[];
  usage: TokenUsage;
  finishReason: "stop" | "tool_calls" | "length";
  /**
   * The model's reasoning/thinking trace (#254), when the provider emits one
   * (`reasoning_content`, Anthropic `thinking` blocks, Bedrock
   * `reasoningContent`). `undefined` for providers/models that don't reason.
   */
  reasoning?: string;
}

/**
 * One event from a streaming chat call. Text arrives incrementally as
 * `delta` events; reasoning (when the model emits a thinking trace) arrives as
 * separate `reasoning` events; the stream ends with exactly one `done` event
 * carrying the complete {@link ChatResponse} (including tool calls and usage).
 *
 * Invariant: the concatenated `delta` contents equal `done.response.content`
 * (both empty/null when the model only emitted tool calls), and the
 * concatenated `reasoning` contents equal `done.response.reasoning`. Reasoning
 * is a separate channel and is emitted before text, so the last event is still
 * `done`. Tool calls are never streamed partially — providers accumulate them
 * internally and surface them only on `done`, since consumers need complete
 * arguments.
 */
export type ChatStreamEvent =
  | { type: "delta"; content: string }
  | { type: "reasoning"; content: string }
  | { type: "done"; response: ChatResponse };

export interface AIProvider {
  id: string;
  name: string;

  chat(params: ChatParams): Promise<ChatResponse>;
  /**
   * Optional streaming variant of {@link chat}. Implement it to let
   * consumers (the agent loop's `onTextDelta` sink, the chat SSE route)
   * render assistant text as it generates. Callers always fall back to
   * `chat()` when absent.
   */
  chatStream?(params: ChatParams): AsyncIterable<ChatStreamEvent>;

  /**
   * Optional model discovery. Implement it to let the setup wizard and
   * config editor offer real model ids instead of free-text entry (the
   * backend's catalog: `GET /v1/models` for OpenAI-family servers,
   * `ListInferenceProfiles` for Bedrock, …). Returns ids in backend
   * order; callers sort/filter for display.
   */
  listModels?(): Promise<string[]>;

  supportsTools: boolean;
}
