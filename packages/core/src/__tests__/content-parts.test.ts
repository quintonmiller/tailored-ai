/**
 * The content model: parts, the text projection, and the storage codec.
 *
 * The theme running through these is that media must never vanish quietly. A
 * surface that cannot show a picture says so; a row that cannot be decoded
 * comes back as its own raw text; a model that cannot be sent an image is told
 * one was here. "Silently dropped" is the outcome the whole design exists to
 * prevent, so it is what most of these assert against.
 */

import { describe, expect, it } from "vitest";
import { decodeMessageContent, ENCODED_MARKER, encodeMessageContent } from "../content/codec.js";
import {
  contentParts,
  hasMedia,
  type MediaRef,
  mediaKind,
  mediaPart,
  mediaPlaceholder,
  mediaRefs,
  messageText,
  partsToText,
  textPart,
  toolOutputText,
} from "../content/types.js";

const png: MediaRef = {
  id: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
  mimeType: "image/png",
  bytes: 2048,
  name: "chart.png",
  width: 1024,
  height: 768,
};

describe("mediaKind", () => {
  it("derives the category from the mime type rather than a stored field", () => {
    expect(mediaKind("image/png")).toBe("image");
    expect(mediaKind("audio/wav")).toBe("audio");
    expect(mediaKind("video/mp4")).toBe("video");
    expect(mediaKind("application/pdf")).toBe("document");
  });

  it("tolerates parameters and casing, since headers carry both", () => {
    expect(mediaKind("IMAGE/PNG")).toBe("image");
    expect(mediaKind("text/plain; charset=utf-8")).toBe("document");
  });

  it("falls back to `other` instead of guessing", () => {
    expect(mediaKind("chemical/x-pdb")).toBe("other");
  });
});

describe("messageText", () => {
  it("passes a plain string through unchanged — the text-only path is untouched", () => {
    expect(messageText("hello")).toBe("hello");
    expect(messageText(null)).toBe("");
    expect(messageText(undefined)).toBe("");
  });

  it("renders a media part as a visible placeholder, never as nothing", () => {
    const text = messageText({ parts: [textPart("look:"), mediaPart(png)] });
    expect(text).toContain("look:");
    expect(text).toContain("chart.png");
    expect(text).toContain("1024×768");
    // The short id is what makes two renderings of the same blob compare equal,
    // which is what keeps the loop's repeat detector working.
    expect(text).toContain("#a1b2c3d4");
  });

  it("is stable for identical content, so the repeat detector still fires", () => {
    const once = messageText({ parts: [mediaPart(png)] });
    const twice = messageText({ parts: [mediaPart(png)] });
    expect(once).toBe(twice);
  });

  it("includes alt text when a caller supplied it", () => {
    expect(messageText({ parts: [mediaPart(png, "revenue by quarter")] })).toContain("revenue by quarter");
  });
});

describe("mediaPlaceholder", () => {
  it("names the kind, the file, its size and a short id", () => {
    expect(mediaPlaceholder(png)).toBe("[image: chart.png 1024×768 image/png #a1b2c3d4]");
  });

  it("falls back to the kind when a blob has no name", () => {
    expect(mediaPlaceholder({ id: "b".repeat(64), mimeType: "audio/wav", bytes: 10 })).toContain("[audio: audio");
  });

  it("omits dimensions for a format that has none", () => {
    const pdf = mediaPlaceholder({ id: "c".repeat(64), mimeType: "application/pdf", bytes: 10, name: "r.pdf" });
    expect(pdf).toBe("[document: r.pdf application/pdf #cccccccc]");
  });
});

describe("partsToText", () => {
  it("preserves order, because position is what carries meaning", () => {
    const text = partsToText([textPart("before"), mediaPart(png), textPart("after")]);
    const lines = text.split("\n");
    expect(lines[0]).toBe("before");
    expect(lines[1]).toContain("chart.png");
    expect(lines[2]).toBe("after");
  });

  it("skips empty text parts rather than emitting blank lines", () => {
    expect(partsToText([textPart(""), textPart("kept")])).toBe("kept");
  });
});

describe("toolOutputText", () => {
  it("passes a plain string through — all existing tools are unaffected", () => {
    expect(toolOutputText("done")).toBe("done");
  });

  it("appends a structured payload so a JSON result is still visible as text", () => {
    const text = toolOutputText({ parts: [textPart("ok")], structured: { count: 3 } });
    expect(text).toContain("ok");
    expect(text).toContain('{"count":3}');
  });

  it("survives a structured payload that cannot be serialized", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => toolOutputText({ parts: [textPart("ok")], structured: cyclic })).not.toThrow();
  });
});

describe("part helpers", () => {
  it("normalizes the string shorthand into parts", () => {
    expect(contentParts("hi")).toEqual([{ type: "text", text: "hi" }]);
    expect(contentParts("")).toEqual([]);
    expect(contentParts(null)).toEqual([]);
  });

  it("reports media presence and collects refs in order", () => {
    expect(hasMedia("just text")).toBe(false);
    expect(hasMedia({ parts: [textPart("a")] })).toBe(false);
    expect(hasMedia({ parts: [mediaPart(png)] })).toBe(true);
    expect(mediaRefs({ parts: [textPart("a"), mediaPart(png)] })).toEqual([png]);
  });
});

describe("storage codec", () => {
  it("stores a plain string verbatim, so no existing row is rewritten", () => {
    expect(encodeMessageContent("hello world")).toBe("hello world");
    expect(decodeMessageContent("hello world")).toBe("hello world");
    expect(encodeMessageContent(null)).toBeNull();
    expect(decodeMessageContent(null)).toBeNull();
  });

  it("stores text-only parts as plain text — encoding buys nothing there", () => {
    expect(encodeMessageContent({ parts: [textPart("a"), textPart("b")] })).toBe("a\nb");
  });

  it("round-trips content carrying media", () => {
    const original = { parts: [textPart("look:"), mediaPart(png, "alt")] };
    const encoded = encodeMessageContent(original);
    expect(encoded).toContain(ENCODED_MARKER);
    expect(decodeMessageContent(encoded)).toEqual(original);
  });

  it("does not mistake ordinary JSON in a message for encoded content", () => {
    // The exact ambiguity the marker exists to prevent: a legacy message whose
    // literal text is a parts array.
    const lookalike = JSON.stringify({ parts: [{ type: "text", text: "not ours" }] });
    expect(decodeMessageContent(lookalike)).toBe(lookalike);
  });

  it("returns raw text when an encoded row holds nothing recognizable", () => {
    // Better to surface the row as its own text than as an empty message.
    const bogus = JSON.stringify({ [ENCODED_MARKER]: 1, parts: [{ type: "nonsense" }] });
    expect(decodeMessageContent(bogus)).toBe(bogus);
  });

  it("drops individual malformed parts but keeps the valid ones", () => {
    const mixed = JSON.stringify({
      [ENCODED_MARKER]: 1,
      parts: [{ type: "text", text: "kept" }, { type: "media" }],
    });
    expect(decodeMessageContent(mixed)).toEqual({ parts: [{ type: "text", text: "kept" }] });
  });

  it("treats malformed JSON as plain text rather than throwing", () => {
    const broken = `{"${ENCODED_MARKER}":1,`;
    expect(decodeMessageContent(broken)).toBe(broken);
  });
});
