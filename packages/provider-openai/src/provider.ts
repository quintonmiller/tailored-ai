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
import { reasoningEffortThinkingMap } from "@tailored-ai/core";
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
      // Reasoning channel (#254): `reasoning_content` (most OpenAI-wire
      // backends) or `reasoning` (some gateways).
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
  } | null;
}

interface ApiChatResponse {
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

/**
 * Which `reasoning_effort` shape a request carries: what the config asked for,
 * the literal `"none"` that newer models require alongside tools, or no field
 * at all for models that reject `"none"`.
 */
type EffortMode = "configured" | "omit" | { set: string };

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
  /** Default reasoning effort (#254), mapped to `reasoning_effort`. Per-call `ChatParams.thinking` overrides it. */
  defaultThinking?: ThinkingLevel;
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
  private defaultThinking?: ThinkingLevel;

  constructor(opts: OpenAIChatProviderOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.organization = opts.organization;
    this.project = opts.project;
    this.reasoningModels = opts.reasoningModels ?? [];
    this.defaultThinking = opts.defaultThinking;
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

  /**
   * What we have learned about a model's `reasoning_effort` handling, keyed by
   * model id. Populated from the API's own 400s rather than a version rule,
   * because there is no version rule that holds:
   *
   * | model | `"none"` | a real effort, with tools |
   * |---|---|---|
   * | gpt-5, gpt-5-mini, o3, o4-mini | rejected | accepted |
   * | gpt-5.1, gpt-5.2 | accepted | accepted |
   * | gpt-5.3-chat-latest | rejected | rejected |
   * | gpt-5.4, 5.4-mini, 5.5, 5.6-* | accepted | rejected |
   *
   * Measured 2026-08-05. A prefix test would already be wrong for
   * `gpt-5.3-chat-latest` and would rot with the next release, so the provider
   * learns instead: one corrective retry the first time a model surprises it,
   * then the right shape for the rest of the process.
   */
  private effortQuirks = new Map<string, { allowsNone?: boolean; effortWithTools?: boolean }>();
  private warnedEffortDropped = new Set<string>();

  private buildBody(params: ChatParams, effortMode: EffortMode = "configured"): Record<string, unknown> {
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

    // Reasoning control (#254): map the resolved level to `reasoning_effort`
    // (valid only on reasoning models — the API rejects it otherwise).
    const level = params.thinking ?? this.defaultThinking;
    if (level) {
      const fragment = reasoningEffortThinkingMap(level, params);
      if (fragment) Object.assign(body, fragment);
    }

    if (params.extra) {
      Object.assign(body, params.extra);
    }

    // Applied last so it wins over `params.extra` too: once the API has told us
    // this shape is rejected, honouring a caller's `reasoning_effort` would only
    // reproduce the 400 we just learned to avoid.
    if (effortMode === "omit") delete body.reasoning_effort;
    else if (effortMode !== "configured") body.reasoning_effort = effortMode.set;

    return body;
  }

  /** The shape to try first, given what this model has already taught us. */
  private plannedEffortMode(params: ChatParams): EffortMode {
    const quirk = this.effortQuirks.get(params.model);
    if (!quirk) return "configured";
    if (params.tools?.length && quirk.effortWithTools === false) {
      return quirk.allowsNone === false ? "omit" : { set: "none" };
    }
    if (quirk.allowsNone === false && this.resolvedLevel(params) === "off") return "omit";
    return "configured";
  }

  private resolvedLevel(params: ChatParams): ThinkingLevel | undefined {
    return params.thinking ?? this.defaultThinking;
  }

  /**
   * Read a 400 about `reasoning_effort` and return the shape to retry with, or
   * undefined to rethrow. Only these two complaints are interpreted; anything
   * else is a real error and must surface, because silently retrying an
   * unrelated 400 with a different body turns one clear failure into two
   * confusing ones.
   */
  private recoverFromEffortError(params: ChatParams, mode: EffortMode, err: Error): EffortMode | undefined {
    const quirk = this.effortQuirks.get(params.model) ?? {};

    // "…are not supported for <model> in /v1/chat/completions" — the model can
    // take tools or reasoning, not both. Fires even when no field was sent, so
    // omitting is not a workaround; only the literal "none" is.
    if (/Function tools with reasoning_effort are not supported/i.test(err.message)) {
      quirk.effortWithTools = false;
      this.effortQuirks.set(params.model, quirk);
      this.warnEffortDropped(params, "cannot combine reasoning with function tools on /chat/completions");
      return quirk.allowsNone === false ? "omit" : { set: "none" };
    }

    // "Unsupported value: 'reasoning_effort' does not support 'X' with this
    // model. Supported values are: 'medium'." The message names what would
    // work, which beats guessing — a model whose only level is `medium` should
    // get `medium` rather than have reasoning dropped entirely.
    const rejected = err.message.match(/'reasoning_effort' does not support '([^']+)'/i)?.[1];
    if (rejected) {
      if (rejected === "none") quirk.allowsNone = false;
      this.effortQuirks.set(params.model, quirk);

      const supported = [...err.message.matchAll(/'([a-z]+)'/gi)]
        .map((m) => m[1])
        .filter((v) => v !== "reasoning_effort" && v !== rejected);

      if (rejected !== "none" && supported.length > 0) {
        this.warnEffortDropped(params, `does not support that effort level (it offers ${supported.join(", ")})`);
        return { set: supported[0] };
      }
      // We were trying to disable reasoning and cannot say so explicitly.
      // Omitting leaves the model on its own default, which is the closest
      // honest approximation.
      return mode === "omit" ? undefined : "omit";
    }

    return undefined;
  }

  private warnEffortDropped(params: ChatParams, reason: string): void {
    const level = this.resolvedLevel(params);
    if (!level || level === "off" || level === "auto") return;
    if (this.warnedEffortDropped.has(params.model)) return;
    this.warnedEffortDropped.add(params.model);
    console.warn(
      `[openai] ${params.model} ${reason}, so thinking="${level}" is not being honoured for this model. ` +
        `Requests still succeed. The Responses API is the endpoint that supports reasoning alongside tools.`,
    );
  }

  /**
   * Issue the request, correcting the `reasoning_effort` shape when the API
   * rejects it. Bounded by refusing to retry a shape that has already failed.
   */
  private async requestChat(params: ChatParams, extra?: Record<string, unknown>): Promise<Response> {
    let mode = this.plannedEffortMode(params);
    const tried = new Set<string>();
    for (;;) {
      tried.add(typeof mode === "string" ? mode : `set:${mode.set}`);
      try {
        return await this.request({ ...this.buildBody(params, mode), ...extra });
      } catch (err) {
        const next = this.recoverFromEffortError(params, mode, err as Error);
        if (!next) throw err;
        if (tried.has(typeof next === "string" ? next : `set:${next.set}`)) throw err;
        mode = next;
      }
    }
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
    const resp = await this.requestChat(params);
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
      reasoning: choice.message.reasoning_content || choice.message.reasoning || undefined,
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
    const resp = await this.requestChat(params, { stream: true, stream_options: { include_usage: true } });
    if (!resp.body) {
      throw new Error("OpenAI API returned no response body for stream");
    }

    let content = "";
    let reasoning = "";
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
