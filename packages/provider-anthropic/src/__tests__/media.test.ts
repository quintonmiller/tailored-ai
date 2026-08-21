/**
 * Media reaching the Anthropic wire.
 *
 * The case that matters is media *inside a tool_result*. Anthropic is one of
 * the few APIs that accepts it there, which means a tool-returned screenshot
 * can stay quarantined as tool output instead of being promoted into a user
 * turn — the position Anthropic's own guidance warns about for content that
 * came from outside your control.
 */

import type { MediaRef, Message } from "@tailored-ai/core";
import { describe, expect, it } from "vitest";
import { toApiMessages } from "../provider.js";

const png: MediaRef = {
  id: "a".repeat(64),
  mimeType: "image/png",
  bytes: 12,
  name: "shot.png",
  width: 400,
  height: 300,
};

const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const hydrated = new Map([[png.id, bytes]]);

function mediaMsg(role: Message["role"], toolCallId?: string): Message {
  return {
    role,
    content: {
      parts: [
        { type: "text", text: "the page" },
        { type: "media", media: png },
      ],
    },
    ...(toolCallId ? { toolCallId } : {}),
  };
}

describe("toApiMessages with media", () => {
  it("puts an image block inside tool_result rather than a following user turn", () => {
    const { messages } = toApiMessages([mediaMsg("tool", "tu_1")], false, hydrated);
    const block = (messages[0].content as Array<Record<string, unknown>>)[0];
    expect(block.type).toBe("tool_result");
    const inner = block.content as Array<Record<string, unknown>>;
    expect(inner[0]).toEqual({ type: "text", text: "the page" });
    expect(inner[1]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") },
    });
  });

  it("sends an image on a user turn as a content block", () => {
    const { messages } = toApiMessages([mediaMsg("user")], false, hydrated);
    const blocks = messages[0].content as Array<Record<string, unknown>>;
    expect(blocks.map((b) => b.type)).toEqual(["text", "image"]);
  });

  it("falls back to the placeholder when the bytes were not hydrated", () => {
    // An image the store no longer holds must be described, not vanish.
    const { messages } = toApiMessages([mediaMsg("tool", "tu_1")], false, undefined);
    const block = (messages[0].content as Array<Record<string, unknown>>)[0];
    expect(typeof block.content).toBe("string");
    expect(block.content as string).toContain("shot.png");
  });

  it("degrades a type Anthropic does not accept, instead of building a 400", () => {
    const wav: MediaRef = { id: "b".repeat(64), mimeType: "audio/wav", bytes: 8, name: "clip.wav" };
    const msg: Message = { role: "user", content: { parts: [{ type: "media", media: wav }] } };
    const { messages } = toApiMessages([msg], false, new Map([[wav.id, bytes]]));
    expect(typeof messages[0].content).toBe("string");
    expect(messages[0].content as string).toContain("clip.wav");
  });

  it("uses a url source directly without needing hydrated bytes", () => {
    const remote: MediaRef = { ...png, id: "c".repeat(64), url: "https://example.test/x.png" };
    const msg: Message = { role: "user", content: { parts: [{ type: "media", media: remote }] } };
    const { messages } = toApiMessages([msg], false, undefined);
    const blocks = messages[0].content as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({ type: "image", source: { type: "url", url: "https://example.test/x.png" } });
  });

  it("leaves text-only conversations exactly as they were", () => {
    const { messages } = toApiMessages([{ role: "user", content: "hi" }], false, hydrated);
    expect(messages).toEqual([{ role: "user", content: "hi" }]);
  });
});
