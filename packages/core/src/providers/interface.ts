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
  /**
   * Opaque provider-specific request fields merged into the outgoing request
   * body (e.g. vLLM's `chat_template_kwargs`). Providers that build their own
   * request shape may ignore keys they don't understand.
   */
  extra?: Record<string, unknown>;
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

/**
 * One event from a streaming chat call. Text arrives incrementally as
 * `delta` events; the stream ends with exactly one `done` event carrying
 * the complete {@link ChatResponse} (including tool calls and usage).
 *
 * Invariant: the concatenated `delta` contents equal `done.response.content`
 * (both empty/null when the model only emitted tool calls). Tool calls are
 * never streamed partially — providers accumulate them internally and
 * surface them only on `done`, since consumers need complete arguments.
 */
export type ChatStreamEvent = { type: "delta"; content: string } | { type: "done"; response: ChatResponse };

export interface AIProvider {
  id: string;
  name: string;

  chat(params: ChatParams): Promise<ChatResponse>;
  /**
   * Optional streaming variant of {@link chat}. Implement it to let
   * consumers (the agent loop's `onTextDelta` sink, the chat SSE route)
   * render assistant text as it generates. Callers always fall back to
   * `chat()` when absent.
   */
  chatStream?(params: ChatParams): AsyncIterable<ChatStreamEvent>;

  /**
   * Optional model discovery. Implement it to let the setup wizard and
   * config editor offer real model ids instead of free-text entry (the
   * backend's catalog: `GET /v1/models` for OpenAI-family servers,
   * `ListInferenceProfiles` for Bedrock, …). Returns ids in backend
   * order; callers sort/filter for display.
   */
  listModels?(): Promise<string[]>;

  supportsTools: boolean;
}
