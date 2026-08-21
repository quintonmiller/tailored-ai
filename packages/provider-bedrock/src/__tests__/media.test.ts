/**
 * Media on the Converse wire.
 *
 * Bedrock was always the provider closest to ready: the SDK's `ContentBlock`
 * union has carried an `image` variant all along and this package simply never
 * constructed one. Converse also takes media inside `toolResult.content`, so a
 * tool-returned screenshot stays tool output rather than being promoted into a
 * user turn.
 */

import type { MediaRef, Message } from "@tailored-ai/core";
import { describe, expect, it } from "vitest";
import { toConverseMessages } from "../provider.js";

const png: MediaRef = {
  id: "d".repeat(64),
  mimeType: "image/png",
  bytes: 8,
  name: "view.png",
  width: 200,
  height: 100,
};

const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9]);
const hydrated = new Map([[png.id, bytes]]);

describe("toConverseMessages with media", () => {
  it("emits an image block inside toolResult content", () => {
    const msg: Message = {
      role: "tool",
      toolCallId: "tu_1",
      content: {
        parts: [
          { type: "text", text: "the view" },
          { type: "media", media: png },
        ],
      },
    };
    const { messages } = toConverseMessages([msg], hydrated);
    const block = messages[0].content?.[0] as { toolResult?: { content?: unknown[] } };
    const inner = block.toolResult?.content as Array<Record<string, unknown>>;
    expect(inner[0]).toEqual({ text: "the view" });
    const image = inner[1] as { image: { format: string; source: { bytes: Uint8Array } } };
    expect(image.image.format).toBe("png");
    expect(Buffer.from(image.image.source.bytes).equals(bytes)).toBe(true);
  });

  it("emits an image block on a plain user turn", () => {
    const msg: Message = { role: "user", content: { parts: [{ type: "media", media: png }] } };
    const { messages } = toConverseMessages([msg], hydrated);
    const block = messages[0].content?.[0] as { image?: { format: string } };
    expect(block.image?.format).toBe("png");
  });

  it("falls back to a text placeholder when bytes are missing", () => {
    const msg: Message = { role: "user", content: { parts: [{ type: "media", media: png }] } };
    const { messages } = toConverseMessages([msg], undefined);
    const block = messages[0].content?.[0] as { text?: string };
    expect(block.text).toContain("view.png");
  });

  it("degrades a format Converse does not accept", () => {
    const wav: MediaRef = { id: "e".repeat(64), mimeType: "audio/wav", bytes: 4, name: "clip.wav" };
    const msg: Message = { role: "user", content: { parts: [{ type: "media", media: wav }] } };
    const { messages } = toConverseMessages([msg], new Map([[wav.id, bytes]]));
    const block = messages[0].content?.[0] as { text?: string };
    expect(block.text).toContain("clip.wav");
  });

  it("never sends an empty toolResult content array", () => {
    // Converse rejects one, and an output that rendered to nothing is exactly
    // when it would otherwise happen.
    const msg: Message = { role: "tool", toolCallId: "tu_1", content: { parts: [] } };
    const { messages } = toConverseMessages([msg], undefined);
    const block = messages[0].content?.[0] as { toolResult?: { content?: unknown[] } };
    expect(block.toolResult?.content?.length).toBeGreaterThan(0);
  });
});
