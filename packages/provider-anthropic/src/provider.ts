import type {
  AIProvider,
  ChatParams,
  ChatResponse,
  ChatStreamEvent,
  Message,
  ThinkingLevel,
  TokenUsage,
  ToolCall,
  ToolSchema,
} from "@tailored-ai/core";
import {
  contentParts,
  type MessageContent,
  mediaPlaceholder,
  messageText,
  ProviderHttpError,
  QuirkMemo,
  runQuirkLadder,
  WarnOnce,
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
  cache_control?: { type: "ephemeral" };
}

interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string };
  cache_control?: { type: "ephemeral" };
}

interface DocumentBlock {
  type: "document";
  source: { type: "base64"; media_type: string; data: string };
  cache_control?: { type: "ephemeral" };
}

/**
 * `tool_result.content` accepts text, image, document and search_result blocks
 * — Anthropic is one of the few APIs where media can be returned *inline* from
 * a tool rather than smuggled into a following user turn.
 */
interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<TextBlock | ImageBlock | DocumentBlock>;
  cache_control?: { type: "ephemeral" };
}

type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock | DocumentBlock;

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
/**
 * Turn one TAI content value into Anthropic blocks.
 *
 * A media part becomes a real `image`/`document` block when its bytes were
 * hydrated for this request and the type is one Anthropic accepts. Otherwise it
 * degrades to its text placeholder — the model is told a picture was there,
 * which is the whole point of the placeholder existing.
 */
function toContentBlocks(
  content: string | MessageContent | null,
  media: ReadonlyMap<string, Buffer> | undefined,
): Array<TextBlock | ImageBlock | DocumentBlock> {
  const blocks: Array<TextBlock | ImageBlock | DocumentBlock> = [];
  const pushText = (text: string) => {
    if (text.length > 0) blocks.push({ type: "text", text });
  };

  for (const part of contentParts(content)) {
    if (part.type === "text") {
      pushText(part.text);
      continue;
    }
    const { media: ref, alt } = part;
    if (ref.url && isSupportedImage(ref.mimeType)) {
      blocks.push({ type: "image", source: { type: "url", url: ref.url } });
      continue;
    }
    const bytes = media?.get(ref.id);
    if (!bytes) {
      pushText(mediaPlaceholder(ref, alt));
      continue;
    }
    const data = bytes.toString("base64");
    if (isSupportedImage(ref.mimeType)) {
      blocks.push({ type: "image", source: { type: "base64", media_type: ref.mimeType, data } });
    } else if (ref.mimeType === "application/pdf") {
      blocks.push({ type: "document", source: { type: "base64", media_type: ref.mimeType, data } });
    } else {
      // Audio and video have no home in this API. Saying so beats a 400.
      pushText(mediaPlaceholder(ref, alt));
    }
  }
  return blocks;
}

/** The four image types the Messages API documents. */
function isSupportedImage(mimeType: string): boolean {
  return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(mimeType.toLowerCase());
}

export function toApiMessages(
  messages: Message[],
  promptCaching: boolean,
  media?: ReadonlyMap<string, Buffer>,
): { system: TextBlock[] | undefined; messages: ApiMessage[] } {
  const systemBlocks: TextBlock[] = [];
  let i = 0;
  while (i < messages.length && messages[i].role === "system") {
    const content = messages[i].content;
    if (content) systemBlocks.push({ type: "text", text: messageText(content) });
    i++;
  }
  if (promptCaching && systemBlocks.length > 0) {
    systemBlocks[systemBlocks.length - 1].cache_control = { type: "ephemeral" };
  }

  const result: ApiMessage[] = [];

  for (; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "system") {
      result.push({ role: "user", content: messageText(msg.content) });
    } else if (msg.role === "tool") {
      // Media rides inside the tool_result, which is where it belongs: the
      // content stays quarantined as tool output rather than being promoted
      // into a user turn, the position Anthropic's own guidance warns about
      // for untrusted content.
      const blocks = toContentBlocks(msg.content, media);
      const hasMediaBlock = blocks.some((b) => b.type === "image" || b.type === "document");
      const block: ToolResultBlock = {
        type: "tool_result",
        tool_use_id: msg.toolCallId ?? "",
        content: hasMediaBlock ? blocks : messageText(msg.content),
      };
      result.push({ role: "user", content: [block] });
    } else if (msg.role === "assistant" && msg.toolCalls?.length) {
      const blocks: ContentBlock[] = [];
      if (msg.content) {
        blocks.push({ type: "text", text: messageText(msg.content) });
      }
      for (const tc of msg.toolCalls) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments });
      }
      result.push({ role: "assistant", content: blocks });
    } else {
      const role = msg.role === "user" ? "user" : "assistant";
      const blocks = toContentBlocks(msg.content, media);
      const hasMediaBlock = blocks.some((b) => b.type === "image" || b.type === "document");
      result.push({ role, content: hasMediaBlock ? blocks : messageText(msg.content) });
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

/**
 * Smallest prefix Anthropic will cache. Below it a breakpoint is accepted and
 * silently ignored, which looks exactly like one that works — hence
 * {@link AnthropicMessagesProvider}'s check of `cache_creation_input_tokens`.
 */
export function minCacheableTokens(model: string): number {
  return /haiku/i.test(model) ? 2048 : 1024;
}

/** ~4 chars/token. Only ever compared against the floor above, so precision buys nothing. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function blockText(block: ContentBlock): string {
  if (block.type === "text") return block.text;
  if (block.type === "tool_result") {
    return typeof block.content === "string" ? block.content : block.content.map(blockText).join("");
  }
  if (block.type === "tool_use") return `${block.name}${JSON.stringify(block.input)}`;
  // Image and document blocks: this estimator exists only to compare a prefix
  // against the minimum cacheable size, and an image is certainly above the
  // few characters its base64 would suggest if measured as text. A flat, honest
  // stand-in beats measuring a payload whose token cost is not a length.
  return MEDIA_BLOCK_TEXT_EQUIVALENT;
}

/** Placeholder string whose length stands in for one media block's token cost. */
const MEDIA_BLOCK_TEXT_EQUIVALENT = "x".repeat(6000);

function messageTokens(msg: ApiMessage): number {
  if (typeof msg.content === "string") return estimateTokens(msg.content);
  return msg.content.reduce((n, b) => n + estimateTokens(blockText(b)), 0);
}

/**
 * Put a rolling cache breakpoint on the history.
 *
 * Anthropic caches what you mark and nothing else, so the two existing
 * breakpoints (system, tools) left the expensive part — the conversation —
 * re-read at full price every turn. On the reference deployment's traffic that
 * was ~23% of the prompt cacheable against ~86% for vendors that cache the
 * whole prefix automatically.
 *
 * The mark goes on the *second-to-last* message rather than the last. The tail
 * of a conversation is rewritten every turn; one message back is the newest
 * point that will still be a prefix of the next request, so each turn reads
 * what the previous one wrote and writes only its own delta. (Anthropic also
 * probes ~20 blocks behind a breakpoint, so the read survives the gap.)
 *
 * Skipped below the minimum cacheable length: a breakpoint there is ignored,
 * and it would waste one of the four the API allows.
 *
 * Mutates `messages` — it is built fresh per request by {@link toApiMessages}.
 */
export function applyHistoryCacheBreakpoint(messages: ApiMessage[], model: string, prefixTokens: number): boolean {
  const target = messages.length - 2;
  if (target < 0) return false;

  let tokens = prefixTokens;
  for (let i = 0; i <= target; i++) tokens += messageTokens(messages[i]);
  if (tokens < minCacheableTokens(model)) return false;

  const msg = messages[target];
  const blocks = toBlocks(msg.content);
  if (blocks.length === 0) return false;
  msg.content = blocks;
  blocks[blocks.length - 1].cache_control = { type: "ephemeral" };
  return true;
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

/**
 * Cache reads/writes count as input — sum them so usage reflects what the API
 * actually processed.
 *
 * The two are also reported separately. Summed alone they are unrecoverable:
 * a perfect cache hit and a completely cold read produce the same `input`, so
 * no change to prompt layout could be shown to have helped. The provider was
 * already reading these fields for a one-shot console warning; it just never
 * recorded them.
 */
function toUsage(usage: Usage | undefined): TokenUsage {
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
  return {
    input: (usage?.input_tokens ?? 0) + cacheWrite + cacheRead,
    output: usage?.output_tokens ?? 0,
    cacheRead,
    cacheWrite,
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
   * Add ephemeral cache breakpoints to the system prompt, the tool
   * definitions and the message history. An agent loop re-sends all three on
   * every one of its rounds, so this is most of the input bill.
   *
   * Defaults to **true**. Anthropic caches only what you mark, unlike OpenAI
   * and DeepSeek which cache the whole prefix automatically; off-by-default
   * meant a correct integration quietly cost several times what it needed to.
   * Set `false` to send no breakpoints at all.
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
  /** Request-shape constraints learned from this model's own refusals. */
  private quirks = new QuirkMemo<{ rejectsTemperature?: boolean }>(() => ({}));
  private warn = new WarnOnce();
  /** Models we placed a history breakpoint for and have not yet seen a cache hit or write from. */
  private markedHistory = new Set<string>();

  constructor(opts: AnthropicMessagesProviderOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.version = opts.version ?? "2023-06-01";
    this.betas = opts.betas?.length ? opts.betas : undefined;
    this.defaultMaxTokens = opts.defaultMaxTokens ?? 4096;
    this.promptCaching = opts.promptCaching ?? true;
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
    const { system, messages } = toApiMessages(params.messages, this.promptCaching, params.media);

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

    if (this.promptCaching) {
      // System and tools sit in front of the messages, so they count toward
      // the history breakpoint's prefix.
      const prefix = JSON.stringify(system ?? "").length / 4 + JSON.stringify(body.tools ?? "").length / 4;
      if (applyHistoryCacheBreakpoint(messages, params.model, Math.ceil(prefix))) {
        this.markedHistory.add(params.model);
      }
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
   * The only refusal this provider knows how to correct.
   *
   * Newer Claude models answer any `temperature` — including the 0.3 default
   * this plugin sends when a caller supplies none — with "`temperature` is
   * deprecated for this model." Sending nothing is not a workaround, because
   * the default is applied here rather than by the API, so the model has to be
   * learned from its own refusal.
   *
   * Anything else, and any 400 once the field is already gone, returns
   * undefined and is rethrown untouched: retrying an unrelated failure with a
   * different body turns one clear error into two confusing ones.
   */
  private recoverFromTemperatureError(model: string, dropped: boolean, err: Error): boolean | undefined {
    if (dropped) return undefined;
    const http = err instanceof ProviderHttpError ? err : undefined;
    if (http?.status !== 400) return undefined;
    if (!/temperature.{0,30}(deprecated|not supported)/i.test(http.bodyText)) return undefined;

    this.quirks.for(model).rejectsTemperature = true;
    this.warn.say(
      `temperature:${model}`,
      `[anthropic] ${model} does not accept a temperature; sending none. ` +
        `agent.temperature has no effect on this model.`,
    );
    return true;
  }

  /** POST, dropping `temperature` if the model turns out to reject it. */
  private async request(params: ChatParams, stream: boolean): Promise<Response> {
    return runQuirkLadder<boolean, Response>({
      initial: this.quirks.peek(params.model)?.rejectsTemperature ?? false,
      key: (dropped) => (dropped ? "no-temperature" : "temperature"),
      attempt: async (dropped) => {
        const body = this.buildBody(params, dropped);
        if (stream) body.stream = true;

        const resp = await fetch(`${this.baseUrl}/v1/messages`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body),
        });
        if (resp.ok) return resp;

        const text = await resp.text();
        throw new ProviderHttpError(resp.status, text, `Anthropic API error ${resp.status}: ${text}`);
      },
      recover: (dropped, err) => this.recoverFromTemperatureError(params.model, dropped, err),
    });
  }

  /**
   * A breakpoint under the minimum cacheable length is accepted and ignored,
   * so a broken cache setup and a working one look identical from the outside.
   * The usage counters are the only evidence, so check them: if we marked the
   * history and the API neither wrote nor read a cache entry, say so once.
   */
  private checkCacheEngaged(model: string, usage: Usage | undefined): void {
    if (!this.promptCaching || !this.markedHistory.has(model)) return;
    // Stop looking either way — one confirmation, or one complaint, is enough
    // for the process.
    this.markedHistory.delete(model);
    if ((usage?.cache_creation_input_tokens ?? 0) > 0 || (usage?.cache_read_input_tokens ?? 0) > 0) return;
    this.warn.say(
      `cache:${model}`,
      `[anthropic] ${model} reported no cache read or write despite prompt caching being on. ` +
        `The prompt is probably under the ${minCacheableTokens(model)}-token minimum, ` +
        `or this model does not support caching.`,
    );
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const resp = await this.request(params, false);
    const data = (await resp.json()) as ApiResponse;
    this.checkCacheEngaged(params.model, data.usage);
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

    this.checkCacheEngaged(params.model, startUsage);

    yield {
      type: "done",
      response: {
        content: content || null,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        reasoning: reasoning || undefined,
        usage: { ...toUsage(startUsage), output: outputTokens },
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
