/**
 * Reading a turn's media back out of the record.
 *
 * This is the producer half of P5b. Without it `Channel.send` would accept
 * media that nothing ever passes it — the `supportsTools` failure mode, which
 * this workstream has already committed twice. So the tests here are less about
 * the query than about proving the wire is connected end to end: a tool result
 * saved through the normal path comes back out as a `MediaRef` a channel can
 * upload.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newSession } from "../agent/session.js";
import type { MediaRef, ToolOutput } from "../content/types.js";
import { saveMessage } from "../db/queries.js";
import { initDatabase } from "../db/schema.js";
import { collectTurnMedia, latestMessageId } from "../media/turn.js";

function ref(id: string, name = "shot.png"): MediaRef {
  return { id: id.padStart(64, "0"), mimeType: "image/png", bytes: 512, name };
}

function toolOutput(...media: MediaRef[]): ToolOutput {
  return { parts: [{ type: "text", text: "done" }, ...media.map((m) => ({ type: "media" as const, media: m }))] };
}

describe("collectTurnMedia", () => {
  let db: Database.Database;
  let sessionId: string;

  beforeEach(() => {
    db = initDatabase(":memory:");
    sessionId = newSession(db, "test-model", "test-provider").id;
  });

  afterEach(() => db.close());

  it("returns nothing for a text-only turn", () => {
    const mark = latestMessageId(db, sessionId);
    saveMessage(db, sessionId, { role: "assistant", content: "no pictures here" });
    expect(collectTurnMedia(db, sessionId, mark)).toEqual([]);
  });

  it("finds media a tool result carried, through the real save path", () => {
    const mark = latestMessageId(db, sessionId);
    saveMessage(db, sessionId, { role: "tool", content: toolOutput(ref("a")), toolCallId: "call-1" });
    const found = collectTurnMedia(db, sessionId, mark);
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe("shot.png");
    expect(found[0].mimeType).toBe("image/png");
  });

  it("ignores media from before the watermark", () => {
    saveMessage(db, sessionId, { role: "tool", content: toolOutput(ref("a")), toolCallId: "old" });
    // Watermark taken *after* the earlier turn: that screenshot is history.
    const mark = latestMessageId(db, sessionId);
    saveMessage(db, sessionId, { role: "tool", content: toolOutput(ref("b")), toolCallId: "new" });
    const found = collectTurnMedia(db, sessionId, mark);
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe(ref("b").id);
  });

  it("never echoes the user's own attachment back at them", () => {
    const mark = latestMessageId(db, sessionId);
    saveMessage(db, sessionId, {
      role: "user",
      content: {
        parts: [
          { type: "text", text: "what is this?" },
          { type: "media", media: ref("c", "mine.png") },
        ],
      },
    });
    saveMessage(db, sessionId, { role: "assistant", content: "a cat" });
    expect(collectTurnMedia(db, sessionId, mark)).toEqual([]);
  });

  it("dedupes an unchanged screen captured repeatedly", () => {
    const mark = latestMessageId(db, sessionId);
    // Content addressing means three captures of one screen share an id.
    for (const call of ["1", "2", "3"]) {
      saveMessage(db, sessionId, { role: "tool", content: toolOutput(ref("a")), toolCallId: call });
    }
    expect(collectTurnMedia(db, sessionId, mark)).toHaveLength(1);
  });

  it("preserves production order across messages", () => {
    const mark = latestMessageId(db, sessionId);
    saveMessage(db, sessionId, { role: "tool", content: toolOutput(ref("a", "first.png")), toolCallId: "1" });
    saveMessage(db, sessionId, { role: "tool", content: toolOutput(ref("b", "second.png")), toolCallId: "2" });
    expect(collectTurnMedia(db, sessionId, mark).map((m) => m.name)).toEqual(["first.png", "second.png"]);
  });

  it("stops at the limit", () => {
    const mark = latestMessageId(db, sessionId);
    for (let i = 0; i < 5; i++) {
      saveMessage(db, sessionId, { role: "tool", content: toolOutput(ref(String(i))), toolCallId: `c${i}` });
    }
    expect(collectTurnMedia(db, sessionId, mark, { limit: 2 })).toHaveLength(2);
    expect(collectTurnMedia(db, sessionId, mark, { limit: 0 })).toEqual([]);
  });

  it("does not read another session's media", () => {
    const other = newSession(db, "test-model", "test-provider").id;
    const mark = latestMessageId(db, sessionId);
    saveMessage(db, other, { role: "tool", content: toolOutput(ref("a")), toolCallId: "1" });
    expect(collectTurnMedia(db, sessionId, mark)).toEqual([]);
  });

  it("survives a plain-text tool result written before the codec existed", () => {
    const mark = latestMessageId(db, sessionId);
    // Legacy rows are bare strings, not encoded content. Decoding must not throw.
    db.prepare("INSERT INTO messages (session_id, role, content, tool_call_id) VALUES (?, 'tool', ?, 'legacy')").run(
      sessionId,
      "plain text from an older build",
    );
    expect(collectTurnMedia(db, sessionId, mark)).toEqual([]);
  });
});

describe("latestMessageId", () => {
  it("is 0 for an empty session, and rises as messages land", () => {
    const db = initDatabase(":memory:");
    const sessionId = newSession(db, "m", "p").id;
    expect(latestMessageId(db, sessionId)).toBe(0);
    saveMessage(db, sessionId, { role: "user", content: "hi" });
    expect(latestMessageId(db, sessionId)).toBeGreaterThan(0);
    db.close();
  });
});
