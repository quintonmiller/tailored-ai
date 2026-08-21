/**
 * Where widened content meets the rest of the runtime: token estimation,
 * persistence, and the provider wire.
 *
 * The first block is the important one. Widening `Message.content` to a bare
 * `ContentPart[]` compiles at almost every existing read site, because `string`
 * and `Array` share `.length` and `.slice` — `estimateTokens` would have gone
 * on returning a number, just the wrong one (a part count instead of a
 * character count). The object arm is what turned that into a compile error.
 * These tests pin the behaviour so it cannot regress back into silence.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { estimateTokens, MEDIA_TOKEN_ESTIMATE } from "../agent/loop.js";
import type { MediaRef } from "../content/types.js";
import { mediaPart, textPart } from "../content/types.js";
import { createSession, getSessionMessages, saveMessage } from "../db/queries.js";
import { initDatabase } from "../db/schema.js";
import type { Message } from "../providers/interface.js";
import { toOpenAIMessages } from "../providers/openai.js";

const png: MediaRef = {
  id: "f".repeat(64),
  mimeType: "image/png",
  bytes: 4096,
  name: "screenshot.png",
  width: 800,
  height: 600,
};

describe("estimateTokens with media", () => {
  it("still counts characters for a plain string", () => {
    expect(estimateTokens({ role: "user", content: "a".repeat(40) })).toBe(10);
  });

  it("counts text parts by their characters, not by how many parts there are", () => {
    const msg: Message = { role: "user", content: { parts: [textPart("a".repeat(40))] } };
    expect(estimateTokens(msg)).toBe(10);
  });

  it("charges media a real cost instead of the length of its placeholder", () => {
    // The regression this guards: a picture priced at ~15 tokens lets a context
    // window fill with images the budget never saw.
    const msg: Message = { role: "user", content: { parts: [mediaPart(png)] } };
    expect(estimateTokens(msg)).toBe(MEDIA_TOKEN_ESTIMATE);
  });

  it("scales with the number of images", () => {
    const msg: Message = { role: "user", content: { parts: [mediaPart(png), mediaPart(png)] } };
    expect(estimateTokens(msg)).toBe(MEDIA_TOKEN_ESTIMATE * 2);
  });

  it("never prices an image below a comparable amount of text", () => {
    const withImage: Message = { role: "user", content: { parts: [mediaPart(png)] } };
    const withCaption: Message = { role: "user", content: "screenshot.png 800x600 image/png" };
    expect(estimateTokens(withImage)).toBeGreaterThan(estimateTokens(withCaption));
  });
});

describe("message persistence", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDatabase(":memory:");
    createSession(db, "s1", "test-model", "test-provider");
  });

  afterEach(() => db.close());

  it("round-trips a plain string unchanged", () => {
    saveMessage(db, "s1", { role: "user", content: "hello" });
    expect(getSessionMessages(db, "s1")[0].content).toBe("hello");
  });

  it("round-trips content carrying media", () => {
    const content = { parts: [textPart("look:"), mediaPart(png, "the chart")] };
    saveMessage(db, "s1", { role: "user", content });
    expect(getSessionMessages(db, "s1")[0].content).toEqual(content);
  });

  it("reads a legacy row written before media existed", () => {
    // No migration rewrote these, so the reader has to keep understanding them.
    db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run("s1", "user", "old row");
    expect(getSessionMessages(db, "s1")[0].content).toBe("old row");
  });

  it("does not corrupt a legacy row whose text merely looks like JSON", () => {
    const jsonish = '{"parts":[{"type":"text","text":"i am just a message"}]}';
    db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run("s1", "user", jsonish);
    expect(getSessionMessages(db, "s1")[0].content).toBe(jsonish);
  });

  it("keeps tool-call pairing intact alongside media", () => {
    saveMessage(db, "s1", {
      role: "assistant",
      content: null,
      toolCalls: [{ id: "t1", name: "screenshot", arguments: {} }],
    });
    saveMessage(db, "s1", { role: "tool", content: { parts: [mediaPart(png)] }, toolCallId: "t1" });
    const [assistant, tool] = getSessionMessages(db, "s1");
    expect(assistant.toolCalls?.[0].id).toBe("t1");
    expect(tool.toolCallId).toBe("t1");
    expect(tool.content).toEqual({ parts: [mediaPart(png)] });
  });
});

describe("toOpenAIMessages", () => {
  it("leaves text-only conversations byte-identical", () => {
    const wire = toOpenAIMessages([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
    expect(wire).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
  });

  it("sends a placeholder for media whose bytes nobody hydrated", () => {
    // The model must still be told an image existed — a vanished image is the
    // worst available outcome, and a JSON-stringified one is the second worst.
    const [wire] = toOpenAIMessages([{ role: "user", content: { parts: [mediaPart(png)] } }]);
    expect(typeof wire.content).toBe("string");
    expect(wire.content).toContain("screenshot.png");
    expect(wire.content).not.toContain("[object Object]");
  });

  it("keeps a tool message's content a string, which vLLM requires", () => {
    const bytes = new Map([[png.id, Buffer.from("not really a png")]]);
    const [wire] = toOpenAIMessages([{ role: "tool", content: { parts: [mediaPart(png)] }, toolCallId: "t1" }], bytes);
    // Even with bytes in hand: vllm-project/vllm#43203 rejects an image part
    // on a tool message, so this one stays flat no matter what is available.
    expect(typeof wire.content).toBe("string");
    expect(wire.tool_call_id).toBe("t1");
  });

  it("inlines a hydrated image on a user turn as a data URI", () => {
    // The regression this pins: the provider declared `toolResultMedia` with
    // mode "follow-up", `adaptForCapabilities` duly moved the image to a user
    // turn, and this converter then flattened that turn too — so no image ever
    // reached a model on the default provider while every layer reported
    // success.
    const bytes = new Map([[png.id, Buffer.from([1, 2, 3, 4])]]);
    const [wire] = toOpenAIMessages([{ role: "user", content: { parts: [textPart("look:"), mediaPart(png)] } }], bytes);
    expect(Array.isArray(wire.content)).toBe(true);
    expect(wire.content).toEqual([
      { type: "text", text: "look:" },
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${Buffer.from([1, 2, 3, 4]).toString("base64")}` },
      },
    ]);
  });

  it("keeps alt as a caption ahead of the image it labels", () => {
    // On the follow-up path this is the only label that survives: the
    // synthesized user turn takes the media parts and nothing else, so text
    // the tool wrote stays behind on the tool message. Without it a model gets
    // two screenshots and no way to tell which is which.
    const bytes = new Map([[png.id, Buffer.from([1])]]);
    const [wire] = toOpenAIMessages([{ role: "user", content: { parts: [mediaPart(png, "04-playing")] } }], bytes);
    expect(wire.content).toEqual([
      { type: "text", text: "04-playing" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from([1]).toString("base64")}` } },
    ]);
  });

  it("does not double up the caption when it falls back to a placeholder", () => {
    // `mediaPlaceholder` already folds alt in.
    const [wire] = toOpenAIMessages([{ role: "user", content: { parts: [mediaPart(png, "04-playing")] } }]);
    expect(typeof wire.content).toBe("string");
    expect(String(wire.content).match(/04-playing/g)).toHaveLength(1);
  });

  it("passes a ref that carries its own URL straight through", () => {
    const remote: MediaRef = { ...png, url: "https://example.test/a.png" };
    const [wire] = toOpenAIMessages([{ role: "user", content: { parts: [mediaPart(remote)] } }], new Map());
    expect(wire.content).toEqual([{ type: "image_url", image_url: { url: "https://example.test/a.png" } }]);
  });

  it("describes a document instead of inlining it — there is no portable block", () => {
    const pdf: MediaRef = { id: "a".repeat(64), mimeType: "application/pdf", bytes: 900, name: "spec.pdf" };
    const bytes = new Map([[pdf.id, Buffer.from([9, 9])]]);
    const [wire] = toOpenAIMessages([{ role: "user", content: { parts: [mediaPart(pdf)] } }], bytes);
    expect(typeof wire.content).toBe("string");
    expect(wire.content).toContain("spec.pdf");
  });

  it("leaves a text-only request untouched when a media map is present", () => {
    // A hydrated map on a request that carries no media must not change the
    // wire shape: the ordinary case has to stay byte-identical.
    const wire = toOpenAIMessages([{ role: "user", content: "hi" }], new Map([[png.id, Buffer.from([1])]]));
    expect(wire).toEqual([{ role: "user", content: "hi" }]);
  });
});
