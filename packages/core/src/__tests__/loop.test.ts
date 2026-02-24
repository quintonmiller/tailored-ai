import { describe, expect, it } from "vitest";
import { estimateTokens, trimHistory } from "../agent/loop.js";
import type { Message } from "../providers/interface.js";

describe("estimateTokens", () => {
  it("estimates tokens for a simple text message", () => {
    const msg: Message = { role: "user", content: "Hello world" }; // 11 chars
    const tokens = estimateTokens(msg);
    expect(tokens).toBe(Math.ceil(11 / 4)); // 3
  });

  it("returns 0 for null content", () => {
    const msg: Message = { role: "assistant", content: null };
    expect(estimateTokens(msg)).toBe(0);
  });

  it("includes tool call name and arguments in count", () => {
    const msg: Message = {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "tc1", name: "exec", arguments: { command: "ls" } }],
    };
    const tokens = estimateTokens(msg);
    // '' (0) + 'exec' (4) + '{"command":"ls"}' (16) = 20 chars -> 5 tokens
    expect(tokens).toBe(5);
  });
});

describe("trimHistory", () => {
  const msg = (role: Message["role"], content: string, toolCallId?: string): Message => ({
    role,
    content,
    ...(toolCallId ? { toolCallId } : {}),
  });

  it("returns all messages when under budget", () => {
    const messages: Message[] = [msg("user", "hi"), msg("assistant", "hello")];
    const result = trimHistory(messages, 1000);
    expect(result).toEqual(messages);
  });

  it("drops oldest messages when over budget", () => {
    const messages: Message[] = [
      msg("user", "a".repeat(100)), // 25 tokens
      msg("assistant", "b".repeat(100)), // 25 tokens
      msg("user", "c".repeat(100)), // 25 tokens
    ];
    // Budget of 30 tokens: should keep only the last 1 message
    const result = trimHistory(messages, 30);
    expect(result.length).toBeLessThan(messages.length);
    // Last message should always be preserved
    expect(result[result.length - 1]).toBe(messages[messages.length - 1]);
  });

  it("skips orphaned tool messages to keep groups intact", () => {
    const messages: Message[] = [
      msg("user", "x".repeat(40)), // 10 tokens
      msg("assistant", "y".repeat(40)), // 10 tokens — has tool call
      msg("tool", "z".repeat(40), "tc1"), // 10 tokens — tool result
      msg("user", "w".repeat(40)), // 10 tokens
    ];
    // Budget of 15: needs to drop some. The tool message at index 2
    // should be skipped along with its preceding assistant message
    const result = trimHistory(messages, 15);
    // Should not start with a tool message
    expect(result[0].role).not.toBe("tool");
  });

  it("always keeps the last message", () => {
    const messages: Message[] = [msg("user", "a".repeat(1000)), msg("user", "b".repeat(1000))];
    const result = trimHistory(messages, 1);
    expect(result.length).toBe(1);
    expect(result[0]).toBe(messages[messages.length - 1]);
  });
});
