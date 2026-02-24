export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatParams {
  model: string;
  messages: Message[];
  tools?: ToolSchema[];
  temperature?: number;
  maxTokens?: number;
}

export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatResponse {
  content: string | null;
  toolCalls?: ToolCall[];
  usage: { input: number; output: number };
  finishReason: "stop" | "tool_calls" | "length";
}

export interface ChatDelta {
  content?: string;
  toolCalls?: Partial<ToolCall>[];
}

export interface AIProvider {
  id: string;
  name: string;

  chat(params: ChatParams): Promise<ChatResponse>;
  chatStream?(params: ChatParams): AsyncIterable<ChatDelta>;

  supportsTools: boolean;
}
