import { describe, expect, it } from "vitest";
import { stripOrphanedToolMessages, trimHistory } from "../agent/loop.js";
import type { Message } from "../providers/interface.js";

const user = (content: string): Message => ({ role: "user", content });
const asst = (
  content: string | null,
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[],
): Message => ({
  role: "assistant",
  content,
  toolCalls,
});
const tool = (toolCallId: string, content: string): Message => ({ role: "tool", content, toolCallId });

describe("stripOrphanedToolMessages", () => {
  it("keeps a well-formed tool-call group", () => {
    const msgs = [user("hi"), asst(null, [{ id: "a", name: "x", arguments: {} }]), tool("a", "ok"), asst("done")];
    expect(stripOrphanedToolMessages(msgs)).toEqual(msgs);
  });

  it("drops a leading orphaned tool message (parent trimmed away)", () => {
    const msgs = [tool("a", "orphan"), user("q"), asst("a")];
    expect(stripOrphanedToolMessages(msgs).map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("drops a tool message after a non-tool message closed the group", () => {
    const msgs = [
      asst(null, [{ id: "a", name: "x", arguments: {} }]),
      tool("a", "ok"),
      user("next"),
      tool("a", "stale"), // group already closed by the user message
    ];
    const out = stripOrphanedToolMessages(msgs);
    expect(out.filter((m) => m.role === "tool")).toHaveLength(1);
  });

  it("keeps multiple parallel tool results for one assistant turn", () => {
    const msgs = [
      asst(null, [
        { id: "a", name: "x", arguments: {} },
        { id: "b", name: "y", arguments: {} },
      ]),
      tool("a", "ra"),
      tool("b", "rb"),
    ];
    expect(stripOrphanedToolMessages(msgs)).toHaveLength(3);
  });

  it("drops a tool message whose id doesn't match the open call", () => {
    const msgs = [asst(null, [{ id: "a", name: "x", arguments: {} }]), tool("zzz", "mismatch")];
    expect(stripOrphanedToolMessages(msgs).filter((m) => m.role === "tool")).toHaveLength(0);
  });

  it("trimHistory never returns a leading orphaned tool message", () => {
    // Build a long history that will be trimmed; the cut can land mid-group.
    const msgs: Message[] = [];
    for (let i = 0; i < 40; i++) {
      msgs.push(asst(null, [{ id: `t${i}`, name: "x", arguments: {} }]));
      msgs.push(tool(`t${i}`, "x".repeat(200)));
    }
    msgs.push(user("final question"));
    const trimmed = trimHistory(msgs, 200);
    // The first non-system message must not be an orphaned tool message.
    const firstTool = trimmed.findIndex((m) => m.role === "tool");
    if (firstTool >= 0) {
      const prev = trimmed[firstTool - 1];
      expect(prev?.role).toBe("assistant");
      expect((prev as Message).toolCalls?.some((tc) => tc.id === trimmed[firstTool].toolCallId)).toBe(true);
    }
  });
});
