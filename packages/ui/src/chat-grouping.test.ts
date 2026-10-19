/**
 * Components a turn's tools sent, lifted out of the folded work log so they
 * render under the reply. Without this they would sit inside the collapsed
 * "Used N tools" panel as text, which is where tool results go.
 */
import { describe, expect, it } from "vitest";
import type { Message } from "./api";
import { groupTurns } from "./chat-grouping";
import type { ComponentSpec } from "./lib/content.js";

const spec = (id: string, question: string): ComponentSpec => ({
  id,
  kind: "choice",
  props: { question, options: ["yes", "no"] },
  fallback: `[choice ${id}] ${question}`,
});

const toolResult = (component: ComponentSpec, toolCallId: string): Message => ({
  role: "tool",
  toolCallId,
  content: {
    parts: [
      { type: "text", text: `Sent choice ${component.id}.` },
      { type: "component", component },
    ],
  },
});

const callTool = (id: string): Message => ({
  role: "assistant",
  content: null,
  toolCalls: [{ id, name: "interface", arguments: {} }],
});

describe("groupTurns with components", () => {
  it("lifts a turn's components onto the reply, latest version of each", () => {
    const grouped = groupTurns([
      { role: "user", content: "Should we ship?" },
      callTool("t1"),
      toolResult(spec("c-1", "Ship today?"), "t1"),
      callTool("t2"),
      toolResult(spec("c-1", "Ship today, or Monday?"), "t2"),
      { role: "assistant", content: "I've asked." },
    ]);
    const reply = grouped.at(-1);
    expect(reply?.content).toBe("I've asked.");
    expect(reply?.components?.map((c) => [c.id, c.props.question])).toEqual([["c-1", "Ship today, or Monday?"]]);
    expect(reply?.toolLog?.length).toBeGreaterThan(0);
  });

  it("keeps components when the turn ended without a closing reply", () => {
    const grouped = groupTurns([
      { role: "user", content: "Ask me" },
      callTool("t1"),
      toolResult(spec("c-2", "Ready?"), "t1"),
    ]);
    expect(grouped.at(-1)?.components?.map((c) => c.id)).toEqual(["c-2"]);
  });

  it("adds nothing to a turn that sent no components", () => {
    const grouped = groupTurns([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(grouped.at(-1)?.components).toBeUndefined();
  });
});

describe("groupTurns with pictures", () => {
  const photo = (id: string, toolCallId: string): Message => ({
    role: "tool",
    toolCallId,
    content: {
      parts: [
        { type: "text", text: "A selfie. It goes out with your reply." },
        { type: "media", media: { id, mimeType: "image/png", bytes: 100, name: "selfie.png" } },
      ],
    },
  });

  it("shows what the turn's tools made with the reply, once each, as Discord attaches it", () => {
    const grouped = groupTurns([
      { role: "user", content: "Send me a selfie" },
      callTool("t1"),
      photo("img-1", "t1"),
      callTool("t2"),
      photo("img-1", "t2"),
      callTool("t3"),
      photo("img-2", "t3"),
      { role: "assistant", content: "Here I am!" },
    ]);
    expect(grouped.at(-1)?.turnMedia?.map((m) => m.id)).toEqual(["img-1", "img-2"]);
  });

  it("leaves a turn without pictures alone", () => {
    const grouped = groupTurns([
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
    ]);
    expect(grouped.at(-1)?.turnMedia).toBeUndefined();
  });
});
