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

export class OpenAIProvider implements AIProvider {
  id = "openai";
  name = "OpenAI";
  supportsTools = true;

  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl = "https://api.openai.com/v1") {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
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

    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`OpenAI API error ${resp.status}: ${text}`);
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
