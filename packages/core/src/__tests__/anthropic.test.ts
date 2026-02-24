import { describe, expect, it } from "vitest";
import type { Message, ToolSchema } from "../providers/interface.js";
import {
  mapStopReason,
  parseAnthropicResponse,
  toAnthropicMessages,
  toAnthropicTools,
} from "../providers/anthropic.js";

describe("toAnthropicMessages", () => {
  it("extracts leading system messages into top-level system", () => {
    const messages: Message[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];
    const { system, messages: result } = toAnthropicMessages(messages);
    expect(system).toBe("You are helpful.");
    expect(result).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("joins multiple leading system messages", () => {
    const messages: Message[] = [
      { role: "system", content: "Line 1" },
      { role: "system", content: "Line 2" },
      { role: "user", content: "Hi" },
    ];
    const { system } = toAnthropicMessages(messages);
    expect(system).toBe("Line 1\nLine 2");
  });

  it("converts mid-conversation system messages to user messages (merged with following user)", () => {
    const messages: Message[] = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "system", content: "New context injected" },
      { role: "user", content: "Continue" },
    ];
    const { system, messages: result } = toAnthropicMessages(messages);
    expect(system).toBeUndefined();
    // system→user merges with the following user message
    expect(result).toHaveLength(3);
    expect(result[2]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "New context injected" },
        { type: "text", text: "Continue" },
      ],
    });
  });

  it("converts tool results to user messages with tool_result blocks", () => {
    const messages: Message[] = [
      { role: "user", content: "Search for news" },
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "tc_1", name: "web_search", arguments: { query: "news" } }],
      },
      { role: "tool", content: "Search results here", toolCallId: "tc_1" },
    ];
    const { messages: result } = toAnthropicMessages(messages);
    expect(result[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tc_1", content: "Search results here" }],
    });
  });

  it("converts assistant tool calls to tool_use content blocks", () => {
    const messages: Message[] = [
      { role: "user", content: "Do something" },
      {
        role: "assistant",
        content: "Let me help",
        toolCalls: [{ id: "tc_1", name: "exec", arguments: { command: "ls" } }],
      },
    ];
    const { messages: result } = toAnthropicMessages(messages);
    expect(result[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Let me help" },
        { type: "tool_use", id: "tc_1", name: "exec", input: { command: "ls" } },
      ],
    });
  });

  it("omits text block when assistant content is null", () => {
    const messages: Message[] = [
      { role: "user", content: "Do something" },
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "tc_1", name: "exec", arguments: { command: "ls" } }],
      },
    ];
    const { messages: result } = toAnthropicMessages(messages);
    expect(result[1]).toEqual({
      role: "assistant",
      content: [{ type: "tool_use", id: "tc_1", name: "exec", input: { command: "ls" } }],
    });
  });

  it("merges adjacent same-role messages (parallel tool results)", () => {
    const messages: Message[] = [
      { role: "user", content: "Search" },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          { id: "tc_1", name: "web_search", arguments: { query: "a" } },
          { id: "tc_2", name: "web_search", arguments: { query: "b" } },
        ],
      },
      { role: "tool", content: "Result A", toolCallId: "tc_1" },
      { role: "tool", content: "Result B", toolCallId: "tc_2" },
    ];
    const { messages: result } = toAnthropicMessages(messages);
    // The two tool results should be merged into one user message
    expect(result).toHaveLength(3);
    expect(result[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tc_1", content: "Result A" },
        { type: "tool_result", tool_use_id: "tc_2", content: "Result B" },
      ],
    });
  });

  it("merges adjacent mid-conversation system + user messages", () => {
    const messages: Message[] = [
      { role: "assistant", content: "Hello" },
      { role: "system", content: "Context update" },
      { role: "user", content: "Continue" },
    ];
    const { messages: result } = toAnthropicMessages(messages);
    // system→user + user should merge
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Context update" },
        { type: "text", text: "Continue" },
      ],
    });
  });

  it("returns undefined system when no leading system messages", () => {
    const messages: Message[] = [{ role: "user", content: "Hi" }];
    const { system } = toAnthropicMessages(messages);
    expect(system).toBeUndefined();
  });
});

describe("toAnthropicTools", () => {
  it("converts ToolSchema[] to Anthropic tool definitions", () => {
    const tools: ToolSchema[] = [
      {
        type: "function",
        function: {
          name: "search",
          description: "Search the web",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        },
      },
    ];
    const result = toAnthropicTools(tools);
    expect(result).toEqual([
      {
        name: "search",
        description: "Search the web",
        input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      },
    ]);
  });
});

describe("mapStopReason", () => {
  it("maps end_turn to stop", () => {
    expect(mapStopReason("end_turn")).toBe("stop");
  });

  it("maps tool_use to tool_calls", () => {
    expect(mapStopReason("tool_use")).toBe("tool_calls");
  });

  it("maps max_tokens to length", () => {
    expect(mapStopReason("max_tokens")).toBe("length");
  });

  it("maps unknown reasons to stop", () => {
    expect(mapStopReason("something_else")).toBe("stop");
  });
});

describe("parseAnthropicResponse", () => {
  it("parses text-only response", () => {
    const response = {
      content: [{ type: "text" as const, text: "Hello!" }],
      stop_reason: "end_turn" as const,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const result = parseAnthropicResponse(response);
    expect(result).toEqual({
      content: "Hello!",
      toolCalls: undefined,
      usage: { input: 10, output: 5 },
      finishReason: "stop",
    });
  });

  it("parses tool_use response", () => {
    const response = {
      content: [
        { type: "text" as const, text: "Let me search." },
        { type: "tool_use" as const, id: "tu_1", name: "search", input: { query: "news" } },
      ],
      stop_reason: "tool_use" as const,
      usage: { input_tokens: 20, output_tokens: 15 },
    };
    const result = parseAnthropicResponse(response);
    expect(result).toEqual({
      content: "Let me search.",
      toolCalls: [{ id: "tu_1", name: "search", arguments: { query: "news" } }],
      usage: { input: 20, output: 15 },
      finishReason: "tool_calls",
    });
  });

  it("parses response with multiple tool calls", () => {
    const response = {
      content: [
        { type: "tool_use" as const, id: "tu_1", name: "search", input: { query: "a" } },
        { type: "tool_use" as const, id: "tu_2", name: "fetch", input: { url: "http://example.com" } },
      ],
      stop_reason: "tool_use" as const,
      usage: { input_tokens: 30, output_tokens: 20 },
    };
    const result = parseAnthropicResponse(response);
    expect(result.content).toBeNull();
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls![0].name).toBe("search");
    expect(result.toolCalls![1].name).toBe("fetch");
  });

  it("returns null content when no text blocks present", () => {
    const response = {
      content: [{ type: "tool_use" as const, id: "tu_1", name: "exec", input: { cmd: "ls" } }],
      stop_reason: "tool_use" as const,
      usage: { input_tokens: 5, output_tokens: 10 },
    };
    const result = parseAnthropicResponse(response);
    expect(result.content).toBeNull();
  });
});
