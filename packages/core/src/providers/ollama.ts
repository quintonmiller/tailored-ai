import type { AIProvider, ChatParams, ChatResponse, ToolCall, ToolSchema } from "./interface.js";

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaChatResponse {
  message: {
    role: string;
    content: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

function toOllamaTools(tools: ToolSchema[]): object[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    },
  }));
}

function toOllamaMessages(messages: ChatParams["messages"]): object[] {
  return messages.map((msg) => {
    if (msg.role === "tool") {
      return {
        role: "tool",
        content: msg.content ?? "",
      };
    }
    if (msg.role === "assistant" && msg.toolCalls?.length) {
      return {
        role: "assistant",
        content: msg.content ?? "",
        tool_calls: msg.toolCalls.map((tc) => ({
          function: {
            name: tc.name,
            arguments: tc.arguments,
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

export class OllamaProvider implements AIProvider {
  id = "ollama";
  name = "Ollama";
  supportsTools = true;

  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: params.model,
      messages: toOllamaMessages(params.messages),
      stream: false,
      options: {
        temperature: params.temperature ?? 0.3,
      },
    };

    if (params.tools?.length) {
      body.tools = toOllamaTools(params.tools);
    }

    if (params.maxTokens) {
      (body.options as Record<string, unknown>).num_predict = params.maxTokens;
    }

    const resp = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Ollama API error ${resp.status}: ${text}`);
    }

    const data = (await resp.json()) as OllamaChatResponse;

    const toolCalls: ToolCall[] | undefined = data.message.tool_calls?.map((tc, i) => ({
      id: `call_${Date.now()}_${i}`,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));

    const hasToolCalls = toolCalls && toolCalls.length > 0;

    return {
      content: data.message.content || null,
      toolCalls: hasToolCalls ? toolCalls : undefined,
      usage: {
        input: data.prompt_eval_count ?? 0,
        output: data.eval_count ?? 0,
      },
      finishReason: hasToolCalls ? "tool_calls" : "stop",
    };
  }
}
