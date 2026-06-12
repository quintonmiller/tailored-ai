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

// --- Messages API wire-format types ---

interface TextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

interface ApiMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: { type: "ephemeral" };
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface ApiResponse {
  content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
  stop_reason: string;
  usage: Usage;
}

/** Streaming event payloads (event type arrives via the SSE `event:` field). */
interface StreamPayload {
  message?: { usage?: Usage };
  index?: number;
  content_block?: { type: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  usage?: Usage;
}

// --- Conversion helpers (exported for testing) ---

/**
 * Convert internal messages to Messages API format. Leading system messages
 * become top-level system blocks (block form so a cache breakpoint can
 * attach); mid-conversation system messages become user turns; adjacent
 * same-role messages merge (the API requires alternating turns).
 */
export function toApiMessages(
  messages: Message[],
  promptCaching: boolean,
): { system: TextBlock[] | undefined; messages: ApiMessage[] } {
  const systemBlocks: TextBlock[] = [];
  let i = 0;
  while (i < messages.length && messages[i].role === "system") {
    const content = messages[i].content;
    if (content) systemBlocks.push({ type: "text", text: content });
    i++;
  }
  if (promptCaching && systemBlocks.length > 0) {
    systemBlocks[systemBlocks.length - 1].cache_control = { type: "ephemeral" };
  }

  const result: ApiMessage[] = [];

  for (; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "system") {
      result.push({ role: "user", content: msg.content ?? "" });
    } else if (msg.role === "tool") {
      const block: ToolResultBlock = {
        type: "tool_result",
        tool_use_id: msg.toolCallId ?? "",
        content: msg.content ?? "",
      };
      result.push({ role: "user", content: [block] });
    } else if (msg.role === "assistant" && msg.toolCalls?.length) {
      const blocks: ContentBlock[] = [];
      if (msg.content) {
        blocks.push({ type: "text", text: msg.content });
      }
      for (const tc of msg.toolCalls) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments });
      }
      result.push({ role: "assistant", content: blocks });
    } else {
      const role = msg.role === "user" ? "user" : "assistant";
      result.push({ role, content: msg.content ?? "" });
    }
  }

  const merged: ApiMessage[] = [];
  for (const msg of result) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role) {
      prev.content = [...toBlocks(prev.content), ...toBlocks(msg.content)];
    } else {
      merged.push(msg);
    }
  }

  return { system: systemBlocks.length > 0 ? systemBlocks : undefined, messages: merged };
}

function toBlocks(content: string | ContentBlock[]): ContentBlock[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  return content;
}

/** Convert tool schemas; with caching, the last tool carries the breakpoint (tools cache as a prefix). */
export function toApiTools(tools: ToolSchema[], promptCaching: boolean): ToolDef[] {
  const defs: ToolDef[] = tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
  if (promptCaching && defs.length > 0) {
    defs[defs.length - 1].cache_control = { type: "ephemeral" };
  }
  return defs;
}

export function mapStopReason(reason: string | undefined): "stop" | "tool_calls" | "length" {
  switch (reason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    default:
      return "stop";
  }
}

/** Cache reads/writes count as input — sum them so usage reflects what the API actually processed. */
function toUsage(usage: Usage | undefined): { input: number; output: number } {
  return {
    input:
      (usage?.input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0),
    output: usage?.output_tokens ?? 0,
  };
}

export function parseApiResponse(data: ApiResponse): ChatResponse {
  let textContent = "";
  const toolCalls: ToolCall[] = [];

  for (const block of data.content ?? []) {
    if (block.type === "text" && block.text) {
      textContent += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id ?? "",
        name: block.name ?? "",
        arguments: block.input ?? {},
      });
    }
  }

  return {
    content: textContent || null,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: toUsage(data.usage),
    finishReason: mapStopReason(data.stop_reason),
  };
}

// --- Provider class ---

export interface AnthropicMessagesProviderOptions {
  apiKey: string;
  /** Defaults to https://api.anthropic.com. */
  baseUrl?: string;
  /** `anthropic-version` header. Defaults to "2023-06-01". */
  version?: string;
  /** Beta feature flags, sent as a comma-joined `anthropic-beta` header. */
  betas?: string[];
  /** `max_tokens` when the caller doesn't set one (the API requires it). Defaults to 4096. */
  defaultMaxTokens?: number;
  /**
   * Add ephemeral cache breakpoints to the system prompt and tool
   * definitions. Agent loops re-send both every iteration, so this cuts
   * input cost/latency substantially on cache hits.
   */
  promptCaching?: boolean;
}

/**
 * Anthropic Messages API provider. Feature superset of core's minimal
 * built-in: configurable version/beta headers, opt-in prompt caching, and
 * `params.extra` passthrough (thinking budgets, top_k, …). Implements
 * chat, chatStream, and listModels.
 */
export class AnthropicMessagesProvider implements AIProvider {
  id = "anthropic";
  name = "Anthropic";
  supportsTools = true;

  private apiKey: string;
  private baseUrl: string;
  private version: string;
  private betas?: string[];
  private defaultMaxTokens: number;
  private promptCaching: boolean;

  constructor(opts: AnthropicMessagesProviderOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.version = opts.version ?? "2023-06-01";
    this.betas = opts.betas?.length ? opts.betas : undefined;
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 4096;
    this.promptCaching = opts.promptCaching ?? false;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": this.version,
    };
    if (this.betas) {
      headers["anthropic-beta"] = this.betas.join(",");
    }
    return headers;
  }

  private buildBody(params: ChatParams): Record<string, unknown> {
    const { system, messages } = toApiMessages(params.messages, this.promptCaching);

    const body: Record<string, unknown> = {
      model: params.model,
      messages,
      max_tokens: params.maxTokens ?? this.defaultMaxTokens,
      temperature: params.temperature ?? 0.3,
    };

    if (system) {
      body.system = system;
    }

    if (params.tools?.length) {
      body.tools = toApiTools(params.tools, this.promptCaching);
    }

    if (params.extra) {
      Object.assign(body, params.extra);
    }

    return body;
  }

  private async request(body: Record<string, unknown>): Promise<Response> {
    const resp = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Anthropic API error ${resp.status}: ${text}`);
    }

    return resp;
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const resp = await this.request(this.buildBody(params));
    const data = (await resp.json()) as ApiResponse;
    return parseApiResponse(data);
  }

  /**
   * Streaming variant: `stream: true` on `/v1/messages`. Text deltas come
   * from `content_block_delta` (`text_delta`); tool-use blocks accumulate
   * their `input_json_delta` fragments per block index and surface complete
   * on `done`. Usage assembles from `message_start` and `message_delta`.
   */
  async *chatStream(params: ChatParams): AsyncIterable<ChatStreamEvent> {
    const body = this.buildBody(params);
    body.stream = true;

    const resp = await this.request(body);
    if (!resp.body) {
      throw new Error("Anthropic API returned no response body for stream");
    }

    let content = "";
    let stopReason: string | undefined;
    let startUsage: Usage | undefined;
    let outputTokens = 0;
    const toolBlocks = new Map<number, { id: string; name: string; json: string }>();

    for await (const msg of parseSseStream(resp.body)) {
      let payload: StreamPayload;
      try {
        payload = JSON.parse(msg.data) as StreamPayload;
      } catch {
        continue;
      }

      switch (msg.event) {
        case "message_start":
          startUsage = payload.message?.usage;
          break;
        case "content_block_start":
          if (payload.content_block?.type === "tool_use" && payload.index !== undefined) {
            toolBlocks.set(payload.index, {
              id: payload.content_block.id ?? "",
              name: payload.content_block.name ?? "",
              json: "",
            });
          }
          break;
        case "content_block_delta":
          if (payload.delta?.type === "text_delta" && payload.delta.text) {
            content += payload.delta.text;
            yield { type: "delta", content: payload.delta.text };
          } else if (payload.delta?.type === "input_json_delta" && payload.index !== undefined) {
            const block = toolBlocks.get(payload.index);
            if (block) block.json += payload.delta.partial_json ?? "";
          }
          break;
        case "message_delta":
          if (payload.delta?.stop_reason) stopReason = payload.delta.stop_reason;
          if (payload.usage?.output_tokens !== undefined) outputTokens = payload.usage.output_tokens;
          break;
        case "error":
          throw new Error(`Anthropic stream error: ${msg.data}`);
        default:
          break; // ping, content_block_stop, message_stop
      }
    }

    const toolCalls: ToolCall[] = [...toolBlocks.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, block]) => ({
        id: block.id,
        name: block.name,
        arguments: JSON.parse(block.json || "{}") as Record<string, unknown>,
      }));

    yield {
      type: "done",
      response: {
        content: content || null,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: { input: toUsage(startUsage).input, output: outputTokens },
        finishReason: mapStopReason(stopReason),
      },
    };
  }

  /** Model discovery via `GET /v1/models`. */
  async listModels(): Promise<string[]> {
    const resp = await fetch(`${this.baseUrl}/v1/models`, { headers: this.headers() });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Anthropic API error ${resp.status}: ${text}`);
    }
    const data = (await resp.json()) as { data?: { id?: string }[] };
    return (data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0);
  }
}
