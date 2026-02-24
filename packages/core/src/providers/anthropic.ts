import type { AIProvider, ChatParams, ChatResponse, Message, ToolCall, ToolSchema } from "./interface.js";

// --- Anthropic wire-format types ---

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicResponse {
  content: AnthropicContentBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens";
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

// --- Conversion helpers (exported for testing) ---

/**
 * Convert internal messages to Anthropic format.
 * Returns { system, messages } since Anthropic takes system as a top-level param.
 */
export function toAnthropicMessages(messages: Message[]): {
  system: string | undefined;
  messages: AnthropicMessage[];
} {
  // Extract leading system messages into the top-level system param
  let systemParts: string[] = [];
  let i = 0;
  while (i < messages.length && messages[i].role === "system") {
    if (messages[i].content) systemParts.push(messages[i].content!);
    i++;
  }

  const result: AnthropicMessage[] = [];

  for (; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "system") {
      // Mid-conversation system messages become user messages
      result.push({ role: "user", content: msg.content ?? "" });
    } else if (msg.role === "tool") {
      // Tool results become user messages with tool_result content blocks
      const block: AnthropicToolResultBlock = {
        type: "tool_result",
        tool_use_id: msg.toolCallId ?? "",
        content: msg.content ?? "",
      };
      result.push({ role: "user", content: [block] });
    } else if (msg.role === "assistant" && msg.toolCalls?.length) {
      // Assistant messages with tool calls become content blocks
      const blocks: AnthropicContentBlock[] = [];
      if (msg.content) {
        blocks.push({ type: "text", text: msg.content });
      }
      for (const tc of msg.toolCalls) {
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: tc.arguments,
        });
      }
      result.push({ role: "assistant", content: blocks });
    } else {
      // Plain user or assistant messages
      const role = msg.role === "user" ? "user" : "assistant";
      result.push({ role, content: msg.content ?? "" });
    }
  }

  // Merge adjacent same-role messages (required by Anthropic)
  const merged: AnthropicMessage[] = [];
  for (const msg of result) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role) {
      // Merge content into the previous message
      const prevBlocks = toContentBlocks(prev.content);
      const curBlocks = toContentBlocks(msg.content);
      prev.content = [...prevBlocks, ...curBlocks];
    } else {
      merged.push(msg);
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n") : undefined,
    messages: merged,
  };
}

function toContentBlocks(content: string | AnthropicContentBlock[]): AnthropicContentBlock[] {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  return content;
}

export function toAnthropicTools(tools: ToolSchema[]): AnthropicToolDef[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

export function mapStopReason(reason: string): "stop" | "tool_calls" | "length" {
  switch (reason) {
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    default:
      return "stop";
  }
}

export function parseAnthropicResponse(data: AnthropicResponse): ChatResponse {
  let textContent = "";
  const toolCalls: ToolCall[] = [];

  for (const block of data.content) {
    if (block.type === "text") {
      textContent += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: block.input,
      });
    }
  }

  const hasToolCalls = toolCalls.length > 0;

  return {
    content: textContent || null,
    toolCalls: hasToolCalls ? toolCalls : undefined,
    usage: {
      input: data.usage.input_tokens,
      output: data.usage.output_tokens,
    },
    finishReason: mapStopReason(data.stop_reason),
  };
}

// --- Provider class ---

export class AnthropicProvider implements AIProvider {
  id = "anthropic";
  name = "Anthropic";
  supportsTools = true;

  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl = "https://api.anthropic.com") {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async chat(params: ChatParams): Promise<ChatResponse> {
    const { system, messages } = toAnthropicMessages(params.messages);

    const body: Record<string, unknown> = {
      model: params.model,
      messages,
      max_tokens: params.maxTokens ?? 4096,
      temperature: params.temperature ?? 0.3,
    };

    if (system) {
      body.system = system;
    }

    if (params.tools?.length) {
      body.tools = toAnthropicTools(params.tools);
    }

    const resp = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Anthropic API error ${resp.status}: ${text}`);
    }

    const data = (await resp.json()) as AnthropicResponse;
    return parseAnthropicResponse(data);
  }
}
