import { describe, expect, it } from "vitest";
import type { Message, ToolSchema } from "../providers/interface.js";
import { toOpenAIMessages, toOpenAITools } from "../providers/openai.js";

describe("toOpenAIMessages", () => {
  it("converts a plain user message", () => {
    const messages: Message[] = [{ role: "user", content: "Hello" }];
    const result = toOpenAIMessages(messages);
    expect(result).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("converts a system message", () => {
    const messages: Message[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hi" },
    ];
    const result = toOpenAIMessages(messages);
    expect(result[0]).toEqual({ role: "system", content: "You are helpful." });
  });

  it("converts null content to empty string", () => {
    const messages: Message[] = [{ role: "user", content: null }];
    const result = toOpenAIMessages(messages);
    expect(result[0].content).toBe("");
  });

  it("converts tool result messages", () => {
    const messages: Message[] = [{ role: "tool", content: "Result data", toolCallId: "tc_1" }];
    const result = toOpenAIMessages(messages);
    expect(result[0]).toEqual({
      role: "tool",
      content: "Result data",
      tool_call_id: "tc_1",
    });
  });

  it("converts tool result with null content to empty string", () => {
    const messages: Message[] = [{ role: "tool", content: null, toolCallId: "tc_1" }];
    const result = toOpenAIMessages(messages);
    expect(result[0].content).toBe("");
  });

  it("converts assistant messages with tool calls", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "Let me search",
        toolCalls: [{ id: "tc_1", name: "search", arguments: { query: "news" } }],
      },
    ];
    const result = toOpenAIMessages(messages);
    expect(result[0]).toEqual({
      role: "assistant",
      content: "Let me search",
      tool_calls: [
        {
          id: "tc_1",
          type: "function",
          function: { name: "search", arguments: '{"query":"news"}' },
        },
      ],
    });
  });

  it("serializes tool call arguments as JSON strings", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "tc_1", name: "exec", arguments: { command: "ls", flags: ["-l", "-a"] } }],
      },
    ];
    const result = toOpenAIMessages(messages);
    const args = result[0].tool_calls![0].function.arguments;
    expect(JSON.parse(args)).toEqual({ command: "ls", flags: ["-l", "-a"] });
  });

  it("handles assistant messages with multiple tool calls", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "tc_1", name: "search", arguments: { query: "a" } },
          { id: "tc_2", name: "fetch", arguments: { url: "http://example.com" } },
        ],
      },
    ];
    const result = toOpenAIMessages(messages);
    expect(result[0].tool_calls).toHaveLength(2);
    expect(result[0].tool_calls![0].id).toBe("tc_1");
    expect(result[0].tool_calls![1].id).toBe("tc_2");
  });

  it("treats assistant message without toolCalls as plain message", () => {
    const messages: Message[] = [{ role: "assistant", content: "Just text" }];
    const result = toOpenAIMessages(messages);
    expect(result[0]).toEqual({ role: "assistant", content: "Just text" });
    expect(result[0].tool_calls).toBeUndefined();
  });

  it("converts a full conversation round-trip", () => {
    const messages: Message[] = [
      { role: "system", content: "Be concise." },
      { role: "user", content: "Search for news" },
      {
        role: "assistant",
        content: null,
        toolCalls: [{ id: "tc_1", name: "web_search", arguments: { query: "news" } }],
      },
      { role: "tool", content: "Search results here", toolCallId: "tc_1" },
      { role: "assistant", content: "Here are the results." },
    ];
    const result = toOpenAIMessages(messages);
    expect(result).toHaveLength(5);
    expect(result[0].role).toBe("system");
    expect(result[1].role).toBe("user");
    expect(result[2].role).toBe("assistant");
    expect(result[2].tool_calls).toHaveLength(1);
    expect(result[3].role).toBe("tool");
    expect(result[3].tool_call_id).toBe("tc_1");
    expect(result[4].role).toBe("assistant");
    expect(result[4].tool_calls).toBeUndefined();
  });
});

describe("toOpenAITools", () => {
  it("converts ToolSchema[] to OpenAI function tool format", () => {
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
    const result = toOpenAITools(tools);
    expect(result).toEqual([
      {
        type: "function",
        function: {
          name: "search",
          description: "Search the web",
          parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        },
      },
    ]);
  });

  it("converts multiple tools", () => {
    const tools: ToolSchema[] = [
      { type: "function", function: { name: "a", description: "Tool A", parameters: {} } },
      { type: "function", function: { name: "b", description: "Tool B", parameters: {} } },
    ];
    const result = toOpenAITools(tools);
    expect(result).toHaveLength(2);
    expect((result[0] as any).function.name).toBe("a");
    expect((result[1] as any).function.name).toBe("b");
  });

  it("returns empty array for empty input", () => {
    expect(toOpenAITools([])).toEqual([]);
  });
});
