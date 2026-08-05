import type {
  AIProvider,
  ChatParams,
  ChatResponse,
  ChatStreamEvent,
  Message,
  ThinkingLevel,
  ToolCall,
  ToolSchema,
} from "@tailored-ai/core";
import { parseSseStream } from "./sse.js";

/**
 * Anthropic extended-thinking budget (#254). `off` omits the field (thinking
 * is off by default); `auto` enables it at a moderate budget; the effort levels
 * map to token budgets (min 1024). Returns the budget in tokens, or null to
 * leave thinking disabled. The number policy is vendor-specific, so it lives in
 * this plugin, not core.
 */
function anthropicThinkingBudget(level: ThinkingLevel | undefined): number | null {
  switch (level) {
    case "low":
      return 1024;
    case "auto":
    case "medium":
      return 4096;
    case "high":
      return 16000;
    default:
      return null; // undefined | "off"
  }
}

/** Whether a request body's `thinking` field (mapper- or extra-supplied) is enabled. */
function isThinkingEnabled(thinking: unknown): boolean {
  return typeof thinking === "object" && thinking !== null && (thinking as { type?: string }).type === "enabled";
}

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
  content: Array<{
    type: string;
    text?: string;
    thinking?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }>;
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
    thinking?: string;
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
  let reasoning = "";
  const toolCalls: ToolCall[] = [];

  for (const block of data.content ?? []) {
    if (block.type === "text" && block.text) {
      textContent += block.text;
    } else if (block.type === "thinking" && block.thinking) {
      reasoning += block.thinking;
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
    reasoning: reasoning || undefined,
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
  /** Default extended-thinking effort (#254). Per-call `ChatParams.thinking` overrides it. */
  defaultThinking?: ThinkingLevel;
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
  private defaultThinking?: ThinkingLevel;
  /** Models that answered a `temperature` with a 400, learned at runtime. */
  private rejectsTemperature = new Set<string>();
  private warnedTemperature = new Set<string>();

  constructor(opts: AnthropicMessagesProviderOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.version = opts.version ?? "2023-06-01";
    this.betas = opts.betas?.length ? opts.betas : undefined;
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 4096;
    this.promptCaching = opts.promptCaching ?? false;
    this.defaultThinking = opts.defaultThinking;
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

  private buildBody(params: ChatParams, dropTemperature = false): Record<string, unknown> {
    const { system, messages } = toApiMessages(params.messages, this.promptCaching);

    const baseMax = params.maxTokens ?? this.defaultMaxTokens;
    const body: Record<string, unknown> = {
      model: params.model,
      messages,
      max_tokens: baseMax,
    };

    if (!dropTemperature) {
      body.temperature = params.temperature ?? 0.3;
    }

    if (system) {
      body.system = system;
    }

    if (params.tools?.length) {
      body.tools = toApiTools(params.tools, this.promptCaching);
    }

    // Reasoning control (#254): enable extended thinking with a token budget.
    // Thinking tokens count against max_tokens, so bump it to leave output
    // room (the API requires max_tokens > budget_tokens).
    const budget = anthropicThinkingBudget(params.thinking ?? this.defaultThinking);
    if (budget !== null) {
      body.thinking = { type: "enabled", budget_tokens: budget };
      body.max_tokens = budget + Math.max(baseMax, 4096);
    }

    if (params.extra) {
      Object.assign(body, params.extra);
    }

    // Anthropic rejects temperature != 1 when thinking is enabled — drop it.
    if (isThinkingEnabled(body.thinking)) {
      delete body.temperature;
    }

    return body;
  }

  /**
   * POST, dropping `temperature` if the model turns out to reject it.
   *
   * Newer Claude models answer any `temperature` — including the 0.3 default
   * this plugin sends when a caller supplies none — with
   * "`temperature` is deprecated for this model." Sending nothing is not a
   * workaround, because the default is applied here rather than by the API. So
   * the model is learned from its own refusal and remembered for the process,
   * the same way the OpenAI provider handles `reasoning_effort` (#385).
   *
   * Once dropped, a further 400 is rethrown: retrying an unrelated failure with
   * a different body turns one clear error into two confusing ones.
   */
  private async request(params: ChatParams, stream: boolean): Promise<Response> {
    let dropTemperature = this.rejectsTemperature.has(params.model);

    for (;;) {
      const body = this.buildBody(params, dropTemperature);
      if (stream) body.stream = true;

      const resp = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });

      if (resp.ok) return resp;

      const text = await resp.text();
      const err = new Error(`Anthropic API error ${resp.status}: ${text}`);
      if (resp.status !== 400 || dropTemperature || !/temperature.{0,30}(deprecated|not supported)/i.test(text)) {
        throw err;
      }

      this.rejectsTemperature.add(params.model);
      if (!this.warnedTemperature.has(params.model)) {
        this.warnedTemperature.add(params.model);
        console.warn(
          `[anthropic] ${params.model} does not accept a temperature; sending none. ` +
            `agent.temperature has no effect on this model.`,
        );
      }
      dropTemperature = true;
    }
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const resp = await this.request(params, false);
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
    const resp = await this.request(params, true);
    if (!resp.body) {
      throw new Error("Anthropic API returned no response body for stream");
    }

    let content = "";
    let reasoning = "";
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
          } else if (payload.delta?.type === "thinking_delta" && payload.delta.thinking) {
            reasoning += payload.delta.thinking;
            yield { type: "reasoning", content: payload.delta.thinking };
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
        reasoning: reasoning || undefined,
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
