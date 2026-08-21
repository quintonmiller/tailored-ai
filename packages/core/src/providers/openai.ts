import { messageText } from "../content/types.js";
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

export interface OpenAIMessage {
  role: string;
  content: string | null;
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
 * Chat Completions takes text here, so media is flattened to its placeholder.
 *
 * Two separate reasons, and both outlive P1 rather than being a stopgap:
 *
 * - **A `tool` message's content is a string, full stop.** vLLM rejects an
 *   `image_url` part on `role: "tool"` with "tool message content only supports
 *   text content" (vllm-project/vllm#43203), even for a vision model that takes
 *   the identical part on a `user` message. Media in a tool result reaches a
 *   Chat Completions model as a following user turn, never inline — see the
 *   degradation ladder in `docs/media-design.md`.
 * - **Resolving a MediaRef needs the store, and this function is sync.** The
 *   user/assistant path can carry `image_url` parts and will, once the
 *   capability pre-flight and async ref resolution land.
 *
 * Flattening through {@link messageText} keeps the lossy step *visible*: the
 * model is told an image was here. It is never silently dropped, and never
 * JSON-stringified into the prompt — which is the exact failure this design
 * exists to avoid.
 */
export function toOpenAIMessages(messages: Message[]): OpenAIMessage[] {
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
      content: text,
    };
  });
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
      messages: toOpenAIMessages(params.messages),
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
