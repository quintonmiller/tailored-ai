/**
 * OpenAI Responses API provider (#378).
 *
 * `/v1/chat/completions` refuses function tools alongside any reasoning effort
 * for `gpt-5.4`, `gpt-5.5` and the whole `gpt-5.6` family, and does not serve
 * `gpt-5.3-codex` at all. Since TAI always sends tools, reasoning and tool use
 * are mutually exclusive there for most of the current lineup. `/v1/responses`
 * has no such restriction. Measured 2026-08-05, tools present:
 *
 * | model | /chat/completions | /v1/responses |
 * |---|---|---|
 * | gpt-5.4, 5.5, 5.6-* | reasoning impossible | every effort accepted |
 * | gpt-5.3-codex | 404 (not served) | accepted |
 * | gpt-5-mini, o4-mini | rejects `none` | rejects `none` |
 * | gpt-5.3-chat-latest | only `medium` | only `medium` |
 *
 * The per-model effort quirks survive the move; the blanket "no reasoning with
 * tools" rule does not. That is the whole reason this class exists.
 */
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
import { isReasoningModel } from "./provider.js";
import { parseSseStream } from "./sse.js";

// --- Wire-format types ---

/** One item in `output[]`, or one item fed back in `input[]`. */
interface OutputItem {
  type: string;
  id?: string;
  status?: string;
  // function_call
  call_id?: string;
  name?: string;
  arguments?: string;
  // message
  role?: string;
  content?: { type: string; text?: string }[];
  // reasoning
  encrypted_content?: string;
  summary?: { type: string; text?: string }[];
}

interface ApiResponse {
  status?: string;
  output?: OutputItem[];
  incomplete_details?: { reason?: string } | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
}

/** A streamed event. The `type` field duplicates the SSE `event:` line. */
interface StreamEvent {
  type?: string;
  delta?: string;
  response?: ApiResponse;
}

// --- Conversion helpers (exported for testing) ---

/**
 * Core `Message[]` → Responses `input[]`.
 *
 * Three shape changes from chat-completions: tool results are
 * `function_call_output` items keyed by `call_id` rather than `role: "tool"`
 * messages; assistant tool calls are top-level `function_call` items rather
 * than a `tool_calls` array nested in the message; and an assistant turn that
 * both spoke and called a tool becomes two items rather than one.
 *
 * `reasoningFor` supplies the opaque reasoning items that produced a given tool
 * call, so they can be replayed — see {@link OpenAIResponsesProvider} for why
 * that is an optimisation rather than a requirement.
 */
export function toResponsesInput(
  messages: Message[],
  reasoningFor?: (callId: string) => OutputItem[] | undefined,
): unknown[] {
  const input: unknown[] = [];

  for (const msg of messages) {
    if (msg.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: msg.toolCallId,
        output: msg.content ?? "",
      });
      continue;
    }

    if (msg.role === "assistant" && msg.toolCalls?.length) {
      // Reasoning is replayed immediately before the calls it produced, which
      // is where the model emitted it. Order matters: the API reads input[] as
      // a transcript.
      const echoed = reasoningFor?.(msg.toolCalls[0].id);
      if (echoed?.length) input.push(...echoed);

      if (msg.content) input.push({ role: "assistant", content: msg.content });

      for (const tc of msg.toolCalls) {
        input.push({
          type: "function_call",
          call_id: tc.id,
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        });
      }
      continue;
    }

    input.push({ role: msg.role, content: msg.content ?? "" });
  }

  return input;
}

/** Tools are declared flat here, not nested under a `function` key. */
export function toResponsesTools(tools: ToolSchema[]): object[] {
  return tools.map((t) => ({
    type: "function",
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  }));
}

/** `ThinkingLevel` → `reasoning.effort`. `auto` means "leave the model alone". */
function toEffort(level: ThinkingLevel): string | undefined {
  if (level === "auto") return undefined;
  if (level === "off") return "none";
  return level;
}

/** The structured half of an OpenAI error body. */
interface ApiError {
  message?: string;
  param?: string;
  code?: string;
}

/**
 * Effort levels ordered by how much thinking they buy. `minimal` exists on some
 * models where `none` does not, which is why "off" cannot simply be dropped.
 */
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high"];

/**
 * The supported level closest to what was asked for, ties going to the cheaper
 * one. Picking the first value the error happens to list would answer "I wanted
 * none" with "high" — the opposite of the request, at the highest price.
 */
export function nearestEffort(requested: string, supported: string[]): string | undefined {
  const wanted = EFFORT_ORDER.indexOf(requested);
  const ranked = supported
    .filter((v) => EFFORT_ORDER.includes(v))
    .sort((a, b) => {
      const da = Math.abs(EFFORT_ORDER.indexOf(a) - wanted);
      const db = Math.abs(EFFORT_ORDER.indexOf(b) - wanted);
      return da !== db ? da - db : EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b);
    });
  return wanted === -1 ? supported[0] : ranked[0];
}

/** Reads `output[]` once, since every field of the response comes out of it. */
function readOutput(data: ApiResponse): {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  reasoningItems: OutputItem[];
} {
  let content = "";
  let reasoning = "";
  const toolCalls: ToolCall[] = [];
  const reasoningItems: OutputItem[] = [];

  for (const item of data.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && part.text) content += part.text;
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id ?? item.id ?? "",
        name: item.name ?? "",
        arguments: parseArgs(item.arguments),
      });
    } else if (item.type === "reasoning") {
      reasoningItems.push(item);
      for (const part of item.summary ?? []) {
        if (part.text) reasoning += part.text;
      }
    }
  }

  return { content, reasoning, toolCalls, reasoningItems };
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // A truncated tool call is a real outcome (hit max_output_tokens mid-call).
    // Losing the whole turn to a JSON error is worse than an empty argument
    // object the tool layer can reject with a useful message.
    return {};
  }
}

// --- Provider ---

export interface OpenAIResponsesProviderOptions {
  apiKey: string;
  /** Defaults to https://api.openai.com/v1. */
  baseUrl?: string;
  organization?: string;
  project?: string;
  /** Extra model-id prefixes to treat as reasoning models (no temperature). */
  reasoningModels?: string[];
  /** Default reasoning effort. Per-call `ChatParams.thinking` overrides it. */
  defaultThinking?: ThinkingLevel;
  /**
   * Ask for a readable reasoning summary. Defaults to `auto`, so the trace TAI
   * captures and renders is populated. Orgs not verified for summaries are
   * detected from the API's refusal and downgraded automatically.
   */
  reasoningSummary?: "auto" | "concise" | "detailed" | "off";
  /**
   * Let OpenAI retain the response server-side. Defaults to false, matching
   * chat-completions, which retains nothing unless asked.
   */
  store?: boolean;
}

/** How a single attempt should shape the reasoning fields. */
interface Attempt {
  effort?: string;
  summary?: string;
}

/** Per-model facts learned from the API's own refusals. */
interface Quirks {
  /** Effort values this model has rejected. */
  rejectedEfforts: Set<string>;
  /** The only effort it says it accepts, when it named one. */
  forcedEffort?: string;
  /** Summaries refused (org not verified). */
  noSummary?: boolean;
}

const MAX_CACHED_REASONING = 64;

/**
 * OpenAI Responses provider. Same `AIProvider` contract as
 * {@link OpenAIChatProvider}; different endpoint, request shape and event
 * stream.
 *
 * **Reasoning replay.** Each response carries opaque `reasoning` items with an
 * `encrypted_content` blob. Feeding them back on the next turn lets the model
 * continue the chain it started instead of re-deriving it. Measured on
 * gpt-5.6-luna: replaying cost 30 reasoning tokens where dropping cost 45.
 *
 * Contrary to what #378 assumed, replay is **not** required — dropping the
 * items returns 200, it just re-reasons. So this is an optimisation, and it is
 * implemented as a provider-private cache keyed by tool-call id rather than by
 * widening `Message`. That keeps core's invariant that `Message.reasoning` is
 * never sent back to a provider: the blob is not a reasoning trace users see,
 * it is an opaque continuation token that happens to live on the same item.
 */
export class OpenAIResponsesProvider implements AIProvider {
  id = "openai";
  name = "OpenAI (Responses)";
  supportsTools = true;

  private apiKey: string;
  private baseUrl: string;
  private organization?: string;
  private project?: string;
  private reasoningModels: string[];
  private defaultThinking?: ThinkingLevel;
  private reasoningSummary: "auto" | "concise" | "detailed" | "off";
  private store: boolean;

  private quirks = new Map<string, Quirks>();
  private warned = new Set<string>();
  /** call_id → the reasoning items emitted in the same response. */
  private reasoningByCall = new Map<string, OutputItem[]>();

  constructor(opts: OpenAIResponsesProviderOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.organization = opts.organization;
    this.project = opts.project;
    this.reasoningModels = opts.reasoningModels ?? [];
    this.defaultThinking = opts.defaultThinking;
    this.reasoningSummary = opts.reasoningSummary ?? "auto";
    this.store = opts.store ?? false;
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

  private quirksFor(model: string): Quirks {
    let q = this.quirks.get(model);
    if (!q) {
      q = { rejectedEfforts: new Set() };
      this.quirks.set(model, q);
    }
    return q;
  }

  /** The attempt to make first, given everything learned about this model. */
  private firstAttempt(params: ChatParams): Attempt {
    const q = this.quirksFor(params.model);
    const level = params.thinking ?? this.defaultThinking;

    let effort = level ? toEffort(level) : undefined;
    if (q.forcedEffort) effort = q.forcedEffort;
    else if (effort && q.rejectedEfforts.has(effort)) effort = undefined;

    const summary = q.noSummary || this.reasoningSummary === "off" ? undefined : this.reasoningSummary;
    return { effort, summary };
  }

  private buildBody(params: ChatParams, attempt: Attempt): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: params.model,
      input: toResponsesInput(params.messages, (id) => this.reasoningByCall.get(id)),
      store: this.store,
    };

    // Reasoning models reject sampling parameters here exactly as they do on
    // chat-completions (`temperature: 0.3` is a 400 on gpt-5.6-luna).
    if (!isReasoningModel(params.model, this.reasoningModels)) {
      body.temperature = params.temperature ?? 0.3;
    }

    if (params.tools?.length) body.tools = toResponsesTools(params.tools);
    if (params.maxTokens) body.max_output_tokens = params.maxTokens;

    const reasoning: Record<string, unknown> = {};
    if (attempt.effort) reasoning.effort = attempt.effort;
    if (attempt.summary) reasoning.summary = attempt.summary;
    if (Object.keys(reasoning).length > 0) body.reasoning = reasoning;

    if (params.extra) Object.assign(body, params.extra);

    return body;
  }

  /**
   * Given a 400, what should the next attempt look like? `undefined` means the
   * error is not one we know how to correct, so it must be rethrown untouched —
   * retrying an unrelated 400 with a different body turns one clear failure
   * into two confusing ones.
   *
   * Keyed on the structured `param`/`code` fields rather than the prose. The
   * wording differs from chat-completions for the same condition
   * (`'none' is not supported with the 'gpt-5-mini' model` here versus
   * `'reasoning_effort' does not support 'none'` there), and prose is the part
   * most likely to be reworded without notice.
   */
  private recover(model: string, attempt: Attempt, apiError: ApiError | undefined, err: Error): Attempt | undefined {
    const q = this.quirksFor(model);
    const message = apiError?.message ?? err.message;

    // "Your organization must be verified to generate reasoning summaries."
    if (attempt.summary && /verified to generate reasoning summaries/i.test(message)) {
      q.noSummary = true;
      this.warnOnce(
        `summary:${model}`,
        `[openai] ${model}: this org is not verified for reasoning summaries, so no reasoning trace will be captured. ` +
          `Verify at https://platform.openai.com/settings/organization/general, or set providers.openai.reasoningSummary: off to silence this.`,
      );
      return { ...attempt, summary: undefined };
    }

    const aboutEffort =
      apiError?.param === "reasoning.effort" || /is not supported with|does not support/i.test(message);
    if (!aboutEffort || attempt.effort === undefined) return undefined;

    q.rejectedEfforts.add(attempt.effort);

    // "Supported values are: 'minimal', 'low', 'medium', and 'high'."
    const listed = message.match(/Supported values are:([^.]*)/i)?.[1] ?? "";
    const supported = [...listed.matchAll(/'([a-z]+)'/gi)].map((m) => m[1]).filter((v) => !q.rejectedEfforts.has(v));

    const best = nearestEffort(attempt.effort, supported);
    if (best) {
      q.forcedEffort = best;
      this.warnOnce(
        `effort:${model}`,
        `[openai] ${model} does not accept reasoning effort '${attempt.effort}' — using '${best}' instead.`,
      );
      return { ...attempt, effort: best };
    }

    // Omitting is accepted by every model measured on this endpoint, so it is a
    // terminal rung rather than another guess.
    this.warnOnce(
      `effort:${model}`,
      `[openai] ${model} rejected reasoning effort '${attempt.effort}'; falling back to the model's own default.`,
    );
    return { ...attempt, effort: undefined };
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(message);
  }

  /**
   * POST with a bounded recovery ladder. Each recognised 400 corrects the shape
   * once; the `tried` set makes termination structural rather than a trusted
   * invariant of the error messages.
   */
  private async request(params: ChatParams, stream: boolean): Promise<Response> {
    let attempt = this.firstAttempt(params);
    const tried = new Set<string>();

    for (;;) {
      const key = `${attempt.effort ?? "-"}|${attempt.summary ?? "-"}`;
      tried.add(key);

      const body = this.buildBody(params, attempt);
      if (stream) body.stream = true;

      const resp = await fetch(`${this.baseUrl}/responses`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });

      if (resp.ok) return resp;

      const text = await resp.text();
      const err = new Error(`OpenAI API error ${resp.status}: ${text}`);
      if (resp.status !== 400) throw err;

      let apiError: ApiError | undefined;
      try {
        apiError = (JSON.parse(text) as { error?: ApiError }).error;
      } catch {
        // Non-JSON body: fall through to prose matching on the message.
      }

      const next = this.recover(params.model, attempt, apiError, err);
      if (!next) throw err;
      if (tried.has(`${next.effort ?? "-"}|${next.summary ?? "-"}`)) throw err;
      attempt = next;
    }
  }

  /** Remember the reasoning that produced these calls, for the next turn. */
  private cacheReasoning(toolCalls: ToolCall[], items: OutputItem[]): void {
    if (items.length === 0 || toolCalls.length === 0) return;

    // Keyed on every call in the turn: the next request replays from the first
    // call's id, but which call that is depends on how history was rebuilt.
    for (const tc of toolCalls) {
      this.reasoningByCall.set(tc.id, items);
    }

    // Bounded: a long-lived provider would otherwise accumulate one entry per
    // tool call for the life of the process.
    while (this.reasoningByCall.size > MAX_CACHED_REASONING) {
      const oldest = this.reasoningByCall.keys().next().value;
      if (oldest === undefined) break;
      this.reasoningByCall.delete(oldest);
    }
  }

  private toChatResponse(data: ApiResponse): ChatResponse {
    const { content, reasoning, toolCalls, reasoningItems } = readOutput(data);
    this.cacheReasoning(toolCalls, reasoningItems);

    const hasToolCalls = toolCalls.length > 0;
    const truncated = data.incomplete_details?.reason === "max_output_tokens";

    return {
      content: content || null,
      toolCalls: hasToolCalls ? toolCalls : undefined,
      reasoning: reasoning || undefined,
      usage: {
        input: data.usage?.input_tokens ?? 0,
        output: data.usage?.output_tokens ?? 0,
      },
      finishReason: hasToolCalls ? "tool_calls" : truncated ? "length" : "stop",
    };
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const resp = await this.request(params, false);
    const data = (await resp.json()) as ApiResponse;
    return this.toChatResponse(data);
  }

  /**
   * Streaming variant. Text arrives as `response.output_text.delta` and the
   * reasoning summary as `response.reasoning_summary_text.delta`; tool calls
   * are not assembled from their own delta events but taken whole from the
   * final `response.completed` payload, which carries the complete response
   * object. That keeps the "tool calls are never streamed partially" invariant
   * without reimplementing argument accumulation.
   */
  async *chatStream(params: ChatParams): AsyncIterable<ChatStreamEvent> {
    const resp = await this.request(params, true);
    if (!resp.body) throw new Error("OpenAI API returned no response body for stream");

    let content = "";
    let reasoning = "";
    let final: ApiResponse | undefined;

    for await (const msg of parseSseStream(resp.body)) {
      if (msg.data === "[DONE]") break;

      let event: StreamEvent;
      try {
        event = JSON.parse(msg.data) as StreamEvent;
      } catch {
        continue; // tolerate keep-alives and malformed frames
      }

      switch (event.type) {
        case "response.output_text.delta":
          if (event.delta) {
            content += event.delta;
            yield { type: "delta", content: event.delta };
          }
          break;

        case "response.reasoning_summary_text.delta":
          if (event.delta) {
            reasoning += event.delta;
            yield { type: "reasoning", content: event.delta };
          }
          break;

        case "response.completed":
        case "response.incomplete":
          final = event.response;
          break;

        case "response.failed": {
          const message = (event.response as { error?: { message?: string } } | undefined)?.error?.message;
          throw new Error(`OpenAI Responses stream failed: ${message ?? "unknown error"}`);
        }
      }
    }

    if (!final) throw new Error("OpenAI Responses stream ended without a completed response");

    // The accumulated deltas are authoritative for text — the invariant is that
    // concatenated deltas equal done.response.content — while tool calls, usage
    // and the finish reason come from the final payload.
    const done = this.toChatResponse(final);
    yield {
      type: "done",
      response: { ...done, content: content || done.content, reasoning: reasoning || done.reasoning },
    };
  }

  /** Model discovery via `GET /models` — shared with chat-completions. */
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
