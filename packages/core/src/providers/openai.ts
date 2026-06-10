import type { AIProvider, ChatParams, ChatResponse, Message, ToolCall, ToolSchema } from "./interface.js";

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

interface OpenAIChatResponse {
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

export function toOpenAIMessages(messages: Message[]): OpenAIMessage[] {
  return messages.map((msg) => {
    if (msg.role === "tool") {
      return {
        role: "tool",
        content: msg.content ?? "",
        tool_call_id: msg.toolCallId,
      };
    }
    if (msg.role === "assistant" && msg.toolCalls?.length) {
      return {
        role: "assistant",
        content: msg.content ?? "",
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
      content: msg.content ?? "",
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
}

export class OpenAIProvider implements AIProvider {
  id: string;
  name: string;
  supportsTools = true;

  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string | undefined, baseUrl = "https://api.openai.com/v1", opts: OpenAIProviderOptions = {}) {
    this.apiKey = apiKey ?? "";
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.id = opts.id ?? "openai";
    this.name = opts.name ?? "OpenAI";
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
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

    if (params.extra) {
      Object.assign(body, params.extra);
    }

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
      usage: {
        input: data.usage?.prompt_tokens ?? 0,
        output: data.usage?.completion_tokens ?? 0,
      },
      finishReason: hasToolCalls ? "tool_calls" : "stop",
    };
  }
}
