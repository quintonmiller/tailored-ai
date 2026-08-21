/**
 * Media arriving from a surface.
 *
 * Two properties matter most here. A text-only message must produce exactly
 * the history row it always did — a `string`, not a one-element parts array —
 * because everything downstream (repeat detection, truncation, search, the
 * storage codec) was tuned against that shape. And a message carrying *only*
 * media must survive, since dropping one is the specific bug that made Slack
 * discard an uncaptioned screenshot before the agent existed.
 */

import { describe, expect, it } from "vitest";
import { type InboundMessage, inboundContent, inboundText } from "../agent/loop.js";
import type { MediaRef } from "../content/types.js";

const png: MediaRef = { id: "a".repeat(64), mimeType: "image/png", bytes: 10, name: "shot.png" };
const pdf: MediaRef = { id: "b".repeat(64), mimeType: "application/pdf", bytes: 20, name: "doc.pdf" };

describe("inboundText", () => {
  it("returns a plain string unchanged", () => {
    expect(inboundText("hello")).toBe("hello");
  });

  it("returns the text of a structured message", () => {
    expect(inboundText({ text: "hello", media: [png] })).toBe("hello");
  });
});

describe("inboundContent", () => {
  it("keeps a plain string a string", () => {
    // Not `{ parts: [...] }`. A text-only turn must be byte-identical to what
    // it was before media existed.
    expect(inboundContent("hello")).toBe("hello");
  });

  it("keeps a structured message with no media a string", () => {
    expect(inboundContent({ text: "hello" })).toBe("hello");
    expect(inboundContent({ text: "hello", media: [] })).toBe("hello");
  });

  it("builds parts when media is attached, text first", () => {
    const content = inboundContent({ text: "what is this?", media: [png] });
    if (typeof content === "string") throw new Error("expected parts");
    expect(content.parts[0]).toEqual({ type: "text", text: "what is this?" });
    expect(content.parts[1]).toEqual({ type: "media", media: png });
  });

  it("survives a message that is only media", () => {
    // Dropping this is the Slack bug: an image posted with no caption never
    // reached the agent at all.
    const content = inboundContent({ text: "", media: [png] });
    if (typeof content === "string") throw new Error("expected parts");
    expect(content.parts).toHaveLength(1);
    expect(content.parts[0].type).toBe("media");
  });

  it("preserves the order media arrived in", () => {
    // Position carries meaning — "this one, then that one" is only expressible
    // by order.
    const content = inboundContent({ text: "two files", media: [png, pdf] });
    if (typeof content === "string") throw new Error("expected parts");
    expect(content.parts.map((p) => (p.type === "media" ? p.media.name : p.type))).toEqual([
      "text",
      "shot.png",
      "doc.pdf",
    ]);
  });

  it("accepts the union both ways at the type level", () => {
    const asString: string | InboundMessage = "hi";
    const asObject: string | InboundMessage = { text: "hi", media: [png] };
    expect(inboundText(asString)).toBe("hi");
    expect(inboundText(asObject)).toBe("hi");
  });
});
