import { describe, expect, it } from "vitest";
import { trimHistory, trimHistoryWithSummary } from "../agent/loop.js";
import type { Message } from "../providers/interface.js";

function userMsg(content: string): Message {
  return { role: "user", content };
}
function asstMsg(content: string): Message {
  return { role: "assistant", content };
}
function toolMsg(content: string): Message {
  return { role: "tool", content, tool_call_id: "x" };
}

describe("trim history — user-message pinning (vLLM-400 safety net)", () => {
  it("keeps the first user message when trimming drops everything else", () => {
    const messages: Message[] = [
      userMsg("ORIGINAL TASK: do the thing"),
      asstMsg("ok i'll do the thing"),
      toolMsg("tool result 1"),
      asstMsg("more reasoning"),
      toolMsg("tool result 2"),
    ];
    // Tight budget — fewer tokens than any single non-trivial message.
    const trimmed = trimHistory(messages, 5);
    expect(trimmed.some((m) => m.role === "user")).toBe(true);
    expect(trimmed.find((m) => m.role === "user")?.content).toBe("ORIGINAL TASK: do the thing");
  });

  it("preserves all user messages when over budget by a bit", () => {
    const messages: Message[] = [
      userMsg("first task"),
      asstMsg("doing it"),
      userMsg("here's an update"),
      asstMsg("got it"),
    ];
    // Trim something but not everything.
    const trimmed = trimHistory(messages, 50);
    expect(trimmed.some((m) => m.role === "user")).toBe(true);
  });

  it("trimHistoryWithSummary preserves a user message after summarization", async () => {
    const messages: Message[] = [
      userMsg("ORIGINAL TASK: do thing X"),
      asstMsg("trying X"),
      toolMsg("X output"),
      asstMsg("more on X"),
      toolMsg("more X output"),
    ];
    // No provider — should still pin user message via the safety net.
    const result = await trimHistoryWithSummary(messages, 5);
    expect(result.messages.some((m) => m.role === "user")).toBe(true);
  });

  it("does not duplicate user message if one already survived", () => {
    const messages: Message[] = [asstMsg("intro"), userMsg("query A"), asstMsg("answer A")];
    const trimmed = trimHistory(messages, 1000);
    // Over budget = false; should return messages unchanged.
    expect(trimmed).toEqual(messages);
    const userCount = trimmed.filter((m) => m.role === "user").length;
    expect(userCount).toBe(1);
  });

  it("noop when history has no user messages at all", () => {
    const messages: Message[] = [asstMsg("a"), asstMsg("b")];
    const trimmed = trimHistory(messages, 1);
    // Should not crash; should also not insert any user message.
    expect(trimmed.every((m) => m.role !== "user")).toBe(true);
  });
});
