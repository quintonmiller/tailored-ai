import type {
  AIProvider,
  ChatParams,
  ChatResponse,
  ChatStreamEvent,
  Message,
  ToolCall,
  ToolSchema,
} from "@tailored-ai/core";
import { parseSseStream } from "./sse.js";

// --- Wire-format types ---

interface ApiMessage {
  role: string;
  content: string | null;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
}

interface StreamChunk {
  choices?: {
    delta?: {
      content?: string | null;
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
  } | null;
}

interface ApiChatResponse {
  choices: {
    message: {
      role: string;
      content: string | null;
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
  };
}

// --- Conversion helpers (exported for testing) ---

export function toApiMessages(messages: Message[]): ApiMessage[] {
  return messages.map((msg) => {
    if (msg.role === "tool") {
      return { role: "tool", content: msg.content ?? "", tool_call_id: msg.toolCallId };
    }
    if (msg.role === "assistant" && msg.toolCalls?.length) {
      return {
        role: "assistant",
        content: msg.content ?? "",
        tool_calls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      };
    }
    return { role: msg.role, content: msg.content ?? "" };
  });
}

export function toApiTools(tools: ToolSchema[]): object[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    },
  }));
}

/**
 * Reasoning models (o-series, gpt-5 family) reject sampling parameters —
 * the API errors on any `temperature` other than the default. Detected by
 * model-id prefix; extend via the `reasoningModels` option as new families
 * appear.
 */
export function isReasoningModel(model: string, extraPrefixes: string[] = []): boolean {
  const id = model.toLowerCase();
  if (/^o\d/.test(id) || id.startsWith("gpt-5")) return true;
  return extraPrefixes.some((p) => id.startsWith(p.toLowerCase()));
}

// --- Provider class ---

export interface OpenAIChatProviderOptions {
  apiKey: string;
  /** Defaults to https://api.openai.com/v1. */
  baseUrl?: string;
  /** `OpenAI-Organization` header, for accounts in multiple orgs. */
  organization?: string;
  /** `OpenAI-Project` header, for per-project usage attribution. */
  project?: string;
  /** Extra model-id prefixes to treat as reasoning models (no temperature). */
  reasoningModels?: string[];
}

/**
 * OpenAI chat-completions provider. Feature superset of core's minimal
 * built-in: `max_completion_tokens` (the `max_tokens` successor reasoning
 * models require), temperature omitted for reasoning models (which reject
 * it), org/project headers, and `params.extra` passthrough (e.g.
 * `reasoning_effort`). Implements chat, chatStream, and listModels.
 */
export class OpenAIChatProvider implements AIProvider {
  id = "openai";
  name = "OpenAI";
  supportsTools = true;

  private apiKey: string;
  private baseUrl: string;
  private organization?: string;
  private project?: string;
  private reasoningModels: string[];

  constructor(opts: OpenAIChatProviderOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.organization = opts.organization;
    this.project = opts.project;
    this.reasoningModels = opts.reasoningModels ?? [];
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (this.organization) headers["OpenAI-Organization"] = this.organization;
    if (this.project) headers["OpenAI-Project"] = this.project;
    return headers;
  }

  private buildBody(params: ChatParams): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: params.model,
      messages: toApiMessages(params.messages),
    };

    if (!isReasoningModel(params.model, this.reasoningModels)) {
      body.temperature = params.temperature ?? 0.3;
    }

    if (params.tools?.length) {
      body.tools = toApiTools(params.tools);
    }

    if (params.maxTokens) {
      // max_tokens is deprecated and rejected by reasoning models;
      // max_completion_tokens covers every current model.
      body.max_completion_tokens = params.maxTokens;
    }

    if (params.extra) {
      Object.assign(body, params.extra);
    }

    return body;
  }

  private async request(body: Record<string, unknown>): Promise<Response> {
    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`OpenAI API error ${resp.status}: ${text}`);
    }

    return resp;
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const resp = await this.request(this.buildBody(params));
    const data = (await resp.json()) as ApiChatResponse;
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
      usage: {
        input: data.usage?.prompt_tokens ?? 0,
        output: data.usage?.completion_tokens ?? 0,
      },
      finishReason: hasToolCalls ? "tool_calls" : choice.finish_reason === "length" ? "length" : "stop",
    };
  }

  /**
   * Streaming variant: `stream: true` + SSE chunk parsing. Text arrives as
   * `delta` events; tool-call fragments accumulate by index and surface
   * complete on `done`. `stream_options.include_usage` requests the final
   * usage chunk.
   */
  async *chatStream(params: ChatParams): AsyncIterable<ChatStreamEvent> {
    const body = this.buildBody(params);
    body.stream = true;
    body.stream_options = { include_usage: true };

    const resp = await this.request(body);
    if (!resp.body) {
      throw new Error("OpenAI API returned no response body for stream");
    }

    let content = "";
    let finishReason: string | null = null;
    let usage = { input: 0, output: 0 };
    const toolFragments = new Map<number, { id: string; name: string; args: string }>();

    for await (const msg of parseSseStream(resp.body)) {
      if (msg.data === "[DONE]") break;
      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(msg.data) as StreamChunk;
      } catch {
        continue; // tolerate malformed keep-alive chunks
      }

      if (chunk.usage) {
        usage = { input: chunk.usage.prompt_tokens ?? 0, output: chunk.usage.completion_tokens ?? 0 };
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;

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
        usage,
        finishReason: hasToolCalls ? "tool_calls" : finishReason === "length" ? "length" : "stop",
      },
    };
  }

  /** Model discovery via `GET /models`. */
  async listModels(): Promise<string[]> {
    const resp = await fetch(`${this.baseUrl}/models`, { headers: this.headers() });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`OpenAI API error ${resp.status}: ${text}`);
    }
    const data = (await resp.json()) as { data?: { id?: string }[] };
    return (data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0);
  }
}
