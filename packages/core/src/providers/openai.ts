import { contentParts, mediaKind, mediaPlaceholder, messageText } from "../content/types.js";
import type { PartialCapabilities } from "./capabilities.js";
import type {
  AIProvider,
  ChatParams,
  ChatResponse,
  ChatStreamEvent,
  Message,
  ThinkingLevel,
  ToolCall,
  ToolSchema,
} from "./interface.js";
import { parseSseStream } from "./sse.js";
import type { ThinkingMapper } from "./thinking.js";

/** A content block on a user or assistant turn. Chat Completions' multimodal shape. */
export type OpenAIContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface OpenAIMessage {
  role: string;
  content: string | OpenAIContentPart[] | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
}

interface OpenAIStreamChunk {
  choices?: {
    delta?: {
      content?: string | null;
      // The de-facto OpenAI-compatible reasoning channels: `reasoning_content`
      // (DeepSeek, vLLM) and `reasoning` (OpenRouter). Captured into the
      // unified `reasoning` field (#254).
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    /**
     * OpenAI-compatible servers that implement prompt caching report it here.
     * Absent on the many that do not, which is why `cacheRead` stays optional
     * all the way up rather than defaulting to zero — "not reported" and
     * "nothing cached" are different facts.
     */
    prompt_tokens_details?: { cached_tokens?: number } | null;
  } | null;
}

interface OpenAIChatResponse {
  choices: {
    message: {
      role: string;
      content: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    };
    finish_reason: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
  };
}

/**
 * An image reaches a user or assistant turn; everything else flattens to text.
 *
 * The asymmetry is the API's, not a preference:
 *
 * - **A `tool` message's content is a string, full stop.** vLLM rejects an
 *   `image_url` part on `role: "tool"` with "tool message content only supports
 *   text content" (vllm-project/vllm#43203), even for a vision model that takes
 *   the identical part on a `user` message. Media returned by a tool reaches
 *   these models as a *following user turn* — which is what
 *   {@link import("./capabilities.js").adaptForCapabilities} synthesizes when
 *   `toolResultMedia.mode` is `follow-up`, and what this provider declares.
 * - **A user or assistant turn takes an array of parts**, which is where an
 *   image can actually go.
 *
 * That second half used to be missing, and the gap was invisible in exactly the
 * way that costs a day: this provider *declared* `toolResultMedia` supported
 * with `mode: "follow-up"`, `adaptForCapabilities` duly moved the image onto a
 * new user turn, and then this function flattened that turn to a placeholder
 * too. Every layer reported success and no image ever reached a model on the
 * default provider. The tell was the token count — a request carrying a
 * 960×720 screenshot billed 244 prompt tokens — and the model's own reasoning
 * trace, which asked whether it could see the image at all.
 *
 * Bytes come from {@link ChatParams.media}, hydrated once per request by the
 * loop. A ref whose bytes are absent — evicted, unreadable, or never stored —
 * degrades to {@link mediaPlaceholder} rather than vanishing: **a part that
 * does not reach the model must leave a placeholder, never nothing.** Only
 * images inline; Chat Completions has no portable block for a PDF, so a
 * document says so in words instead of being JSON-stringified into the prompt.
 */
export function toOpenAIMessages(messages: Message[], media?: ReadonlyMap<string, Buffer>): OpenAIMessage[] {
  return messages.map((msg) => {
    const text = messageText(msg.content);
    if (msg.role === "tool") {
      return {
        role: "tool",
        content: text,
        tool_call_id: msg.toolCallId,
      };
    }
    if (msg.role === "assistant" && msg.toolCalls?.length) {
      return {
        role: "assistant",
        content: text,
        tool_calls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        })),
      };
    }
    return {
      role: msg.role,
      content: multimodalContent(msg, media) ?? text,
    };
  });
}

/**
 * The parts array for a turn carrying at least one sendable image.
 *
 * Returns undefined when there is nothing to gain — no media, or no bytes for
 * any of it — so the ordinary text-only request is byte-for-byte what it was
 * before this existed, and a caller that never hydrates media is unaffected.
 */
function multimodalContent(msg: Message, media?: ReadonlyMap<string, Buffer>): OpenAIContentPart[] | undefined {
  const parts = contentParts(msg.content);
  if (!parts.some((p) => p.type === "media")) return undefined;

  const out: OpenAIContentPart[] = [];
  let sentAnImage = false;
  for (const part of parts) {
    if (part.type === "text") {
      if (part.text) out.push({ type: "text", text: part.text });
      continue;
    }
    const { media: ref, alt } = part;
    const isImage = mediaKind(ref.mimeType) === "image";
    /*
     * The caption goes in, ahead of its image.
     *
     * `alt` is the only label an inlined image can carry, and on the
     * `follow-up` path it is the only one that survives at all: the synthesized
     * user turn takes `...media` and nothing else, so any text the tool wrote
     * stays behind on the `tool` message. Dropping `alt` there hands a model
     * two screenshots with no way to tell which is which — measured on a
     * playtest that sends the opening screen and a mid-play frame together.
     */
    const caption = alt ? [{ type: "text" as const, text: alt }] : [];
    // A ref carrying its own URL is the provider's to fetch, so the bytes were
    // deliberately never hydrated for it.
    if (isImage && ref.url) {
      out.push(...caption, { type: "image_url", image_url: { url: ref.url } });
      sentAnImage = true;
      continue;
    }
    const bytes = isImage ? media?.get(ref.id) : undefined;
    if (!bytes) {
      // The placeholder already folds `alt` in, so no separate caption here.
      out.push({ type: "text", text: mediaPlaceholder(ref, alt) });
      continue;
    }
    out.push(...caption, {
      type: "image_url",
      image_url: { url: `data:${ref.mimeType};base64,${bytes.toString("base64")}` },
    });
    sentAnImage = true;
  }
  return sentAnImage ? out : undefined;
}

export function toOpenAITools(tools: ToolSchema[]): object[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    },
  }));
}

export interface OpenAIProviderOptions {
  /** Provider id, useful when wrapping an OpenAI-compatible server (e.g. "openai_compatible", "vllm"). */
  id?: string;
  /** Human-readable name shown in UIs and logs. */
  name?: string;
  /**
   * Maps a provider-agnostic {@link ThinkingLevel} to this backend's wire
   * fields (#254). Provider plugins built on this class (DeepSeek, OpenRouter)
   * pass their dialect's mapper. Omit to ignore `thinking` entirely — the safe
   * default for a generic OpenAI-compatible endpoint.
   */
  thinkingMap?: ThinkingMapper;
  /** Reasoning effort used when a call doesn't set `ChatParams.thinking`. */
  defaultThinking?: ThinkingLevel;
}

export class OpenAIProvider implements AIProvider {
  id: string;
  name: string;
  supportsTools = true;

  /**
   * Chat Completions, which is what this provider and every OpenAI-compatible
   * gateway speak.
   *
   * The one thing worth stating confidently is the tool-result rule: a `tool`
   * message's content is a string here, full stop. vLLM rejects an `image_url`
   * part on `role: "tool"` with "tool message content only supports text
   * content" (vllm-project/vllm#43203) even for a vision model that accepts the
   * identical part on a user turn. So media returned by a tool reaches these
   * models as a following user message or not at all.
   *
   * Everything else stays unknown on purpose. This provider fronts arbitrary
   * local gateways serving whatever was last loaded under whatever name, so
   * declaring a modality from the model string would be a guess wearing a
   * uniform. The operator sets `capabilities` on the rung when they know.
   */
  capabilities(_model: string): PartialCapabilities {
    return {
      toolResultMedia: { supported: true, mode: "follow-up" },
      tools: { supported: true },
    };
  }

  private apiKey: string;
  private baseUrl: string;
  private thinkingMap?: ThinkingMapper;
  private defaultThinking?: ThinkingLevel;

  constructor(apiKey: string | undefined, baseUrl = "https://api.openai.com/v1", opts: OpenAIProviderOptions = {}) {
    this.apiKey = apiKey ?? "";
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.id = opts.id ?? "openai";
    this.name = opts.name ?? "OpenAI";
    this.thinkingMap = opts.thinkingMap;
    this.defaultThinking = opts.defaultThinking;
  }

  private buildBody(params: ChatParams): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: params.model,
      messages: toOpenAIMessages(params.messages, params.media),
      temperature: params.temperature ?? 0.3,
    };

    if (params.tools?.length) {
      body.tools = toOpenAITools(params.tools);
    }

    if (params.maxTokens) {
      body.max_tokens = params.maxTokens;
    }

    // Reasoning control (#254): map the resolved level, then let a per-call
    // `extra` win over the mapped fragment.
    const level = params.thinking ?? this.defaultThinking;
    if (level && this.thinkingMap) {
      const fragment = this.thinkingMap(level, params);
      if (fragment) Object.assign(body, fragment);
    }

    if (params.extra) {
      Object.assign(body, params.extra);
    }

    return body;
  }

  private async request(body: Record<string, unknown>): Promise<Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`${this.name} API error ${resp.status}: ${text}`);
    }

    return resp;
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const resp = await this.request(this.buildBody(params));
    const data = (await resp.json()) as OpenAIChatResponse;
    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error("OpenAI API returned no choices");
    }

    const toolCalls: ToolCall[] | undefined = choice.message.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
    }));

    const hasToolCalls = toolCalls && toolCalls.length > 0;

    return {
      content: choice.message.content || null,
      toolCalls: hasToolCalls ? toolCalls : undefined,
      reasoning: choice.message.reasoning_content || choice.message.reasoning || undefined,
      usage: {
        input: data.usage?.prompt_tokens ?? 0,
        output: data.usage?.completion_tokens ?? 0,
        cacheRead: data.usage?.prompt_tokens_details?.cached_tokens,
      },
      finishReason: hasToolCalls ? "tool_calls" : "stop",
    };
  }

  /**
   * Streaming variant: `stream: true` + SSE chunk parsing. Text arrives as
   * `delta` events; tool-call fragments accumulate by index and surface
   * complete on `done`. `stream_options.include_usage` requests the final
   * usage chunk (OpenAI, vLLM, Ollama, LM Studio all honor it); servers
   * that omit usage produce zeros, same tolerance as `chat()`.
   */
  async *chatStream(params: ChatParams): AsyncIterable<ChatStreamEvent> {
    const body = this.buildBody(params);
    body.stream = true;
    body.stream_options = { include_usage: true };

    const resp = await this.request(body);
    if (!resp.body) {
      throw new Error(`${this.name} API returned no response body for stream`);
    }

    let content = "";
    let reasoning = "";
    let finishReason: string | null = null;
    let usage = { input: 0, output: 0 };
    const toolFragments = new Map<number, { id: string; name: string; args: string }>();

    for await (const msg of parseSseStream(resp.body)) {
      if (msg.data === "[DONE]") break;
      let chunk: OpenAIStreamChunk;
      try {
        chunk = JSON.parse(msg.data) as OpenAIStreamChunk;
      } catch {
        continue; // tolerate malformed keep-alive chunks
      }

      if (chunk.usage) {
        usage = { input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 };
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const reasoningDelta = choice.delta?.reasoning_content ?? choice.delta?.reasoning;
      if (reasoningDelta) {
        reasoning += reasoningDelta;
        yield { type: "reasoning", content: reasoningDelta };
      }

      if (choice.delta?.content) {
        content += choice.delta.content;
        yield { type: "delta", content: choice.delta.content };
      }

      for (const tc of choice.delta?.tool_calls ?? []) {
        const frag = toolFragments.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) frag.id = tc.id;
        if (tc.function?.name) frag.name += tc.function.name;
        if (tc.function?.arguments) frag.args += tc.function.arguments;
        toolFragments.set(tc.index, frag);
      }
    }

    const toolCalls: ToolCall[] = [...toolFragments.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, frag]) => ({
        id: frag.id,
        name: frag.name,
        arguments: JSON.parse(frag.args || "{}") as Record<string, unknown>,
      }));
    const hasToolCalls = toolCalls.length > 0;

    yield {
      type: "done",
      response: {
        content: content || null,
        toolCalls: hasToolCalls ? toolCalls : undefined,
        reasoning: reasoning || undefined,
        usage,
        finishReason: hasToolCalls ? "tool_calls" : finishReason === "length" ? "length" : "stop",
      },
    };
  }

  /** Model discovery via `GET {baseUrl}/models` — works for OpenAI, vLLM, Ollama (`/v1`), LM Studio. */
  async listModels(): Promise<string[]> {
    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    const resp = await fetch(`${this.baseUrl}/models`, { headers });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`${this.name} API error ${resp.status}: ${text}`);
    }
    const data = (await resp.json()) as { data?: { id?: string }[] };
    return (data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0);
  }
}
