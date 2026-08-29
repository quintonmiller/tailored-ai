/**
 * The seam that decides what a model sees when a picture arrives.
 *
 * Core ships no strategy, so these use hand-written renditions standing in for
 * the plugins that would supply one — OCR, resize, describe, path-only. What is
 * under test is the platform: that a rendition replaces the part, that a broken
 * one costs quality and not the turn, that the cache stops a five-round turn
 * paying five times, and that serving a rendition keeps its original alive.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../agent/loop.js";
import { newSession } from "../agent/session.js";
import type { ContentPart, MediaRef } from "../content/types.js";
import { mediaPart, textPart } from "../content/types.js";
import { getSessionMessages } from "../db/queries.js";
import { initDatabase } from "../db/schema.js";
import type { MediaStore } from "../media/interface.js";
import { getMediaRow, upsertMediaRow } from "../media/queries.js";
import { SqliteRenditionCache } from "../media/rendition-cache.js";
import {
  applyRenditions,
  type MediaRendition,
  type ResolvedRendition,
  recipeFor,
  registerMediaRenditionFactory,
  resolveMediaRendition,
} from "../media/renditions.js";
import type { AIProvider, Message } from "../providers/interface.js";

const png: MediaRef = { id: "a".repeat(64), mimeType: "image/png", bytes: 2048, name: "shot.png" };

function storeWith(bytes = Buffer.from([1, 2, 3])): MediaStore & { reads: number } {
  const store = {
    reads: 0,
    put: vi.fn(async () => png),
    get: vi.fn(async () => {
      store.reads += 1;
      return { ref: png, bytes };
    }),
    stat: vi.fn(async () => png),
  };
  return store as unknown as MediaStore & { reads: number };
}

function resolvedOf(rendition: MediaRendition, recipe = "test:0"): ResolvedRendition {
  return { rendition, recipe };
}

/** Every content part across a request. Tool-call turns carry `content: null`. */
function partsOf(messages: Message[]): ContentPart[] {
  return messages.flatMap((m) => (m.content && typeof m.content !== "string" ? m.content.parts : []));
}

const userWithImage: Message[] = [
  { role: "system", content: "you are a helper" },
  { role: "user", content: { parts: [textPart("what is this?"), mediaPart(png)] } },
];

describe("recipeFor", () => {
  it("is stable across key order, so two spellings of one config share a cache entry", () => {
    expect(recipeFor("resize", { maxWidth: 640, quality: 60 })).toBe(
      recipeFor("resize", { quality: 60, maxWidth: 640 }),
    );
  });

  it("changes when the settings change, because the answer does", () => {
    // A 640px thumbnail and a 128px one are different renditions of one blob;
    // keying on the transform alone would serve whichever ran first forever.
    expect(recipeFor("resize", { maxWidth: 640 })).not.toBe(recipeFor("resize", { maxWidth: 128 }));
  });

  it("separates two transforms configured identically", () => {
    expect(recipeFor("ocr", { lang: "eng" })).not.toBe(recipeFor("describe", { lang: "eng" }));
  });
});

describe("applyRenditions", () => {
  it("replaces the picture with what the rendition returned", async () => {
    const ocr = { render: async () => [textPart("TOTAL 42.00")] };
    const out = await applyRenditions(userWithImage, resolvedOf(ocr), { store: storeWith(), options: {} });

    const parts = (out[1].content as { parts: ContentPart[] }).parts;
    expect(parts.map((p) => p.type)).toEqual(["text", "text"]);
    expect(parts[1]).toMatchObject({ type: "text", text: "TOTAL 42.00" });
    // The question the user asked is untouched.
    expect(parts[0]).toMatchObject({ text: "what is this?" });
  });

  it("can return text AND media, which is what a handle-carrying rendition needs", async () => {
    const thumb: MediaRef = { ...png, id: "b".repeat(64), bytes: 300 };
    const cheap = {
      render: async (ref: MediaRef) => [mediaPart(thumb), textPart(`full image #${ref.id.slice(0, 8)}`)],
    };
    const out = await applyRenditions(userWithImage, resolvedOf(cheap), { store: storeWith(), options: {} });

    const parts = (out[1].content as { parts: ContentPart[] }).parts;
    expect(parts.map((p) => p.type)).toEqual(["text", "media", "text"]);
    expect(parts[2]).toMatchObject({ text: `full image #${"a".repeat(8)}` });
  });

  it("leaves a conversation with no pictures completely alone", async () => {
    const never = { render: vi.fn(async () => [textPart("should not run")]) };
    const plain: Message[] = [{ role: "user", content: "just talking" }];
    const out = await applyRenditions(plain, resolvedOf(never), { store: storeWith(), options: {} });

    expect(never.render).not.toHaveBeenCalled();
    expect(out[0].content).toBe("just talking");
  });

  it("keeps the picture when the rendition throws", async () => {
    // A broken OCR plugin should cost the agent its text extraction, not its
    // image and not its turn.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = {
      render: async () => {
        throw new Error("tesseract exploded");
      },
    };
    const out = await applyRenditions(userWithImage, resolvedOf(broken), { store: storeWith(), options: {} });

    const parts = (out[1].content as { parts: ContentPart[] }).parts;
    expect(parts.map((p) => p.type)).toEqual(["text", "media"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not read bytes for a rendition that never asks", async () => {
    // A path-only rendition answers from the ref. Reading a 4 MB screenshot to
    // print its filename would be the most expensive no-op in the loop.
    const store = storeWith();
    const pathOnly = { render: async (ref: MediaRef) => [textPart(`/media/${ref.id}`)] };
    await applyRenditions(userWithImage, resolvedOf(pathOnly), { store, options: {} });
    expect(store.reads).toBe(0);
  });

  it("reads bytes once however often a rendition asks", async () => {
    const store = storeWith();
    const greedy = {
      render: async (_ref: MediaRef, ctx: { bytes(): Promise<Buffer> }) => {
        const a = await ctx.bytes();
        const b = await ctx.bytes();
        return [textPart(`${a.length}/${b.length}`)];
      },
    };
    await applyRenditions(userWithImage, resolvedOf(greedy), { store, options: {} });
    expect(store.reads).toBe(1);
  });

  it("hands the rendition its configured options", async () => {
    const seen: Record<string, unknown>[] = [];
    const peek = {
      render: async (_r: MediaRef, ctx: { options: Record<string, unknown> }) => {
        seen.push(ctx.options);
        return [textPart("ok")];
      },
    };
    await applyRenditions(userWithImage, resolvedOf(peek), { store: storeWith(), options: { maxWidth: 640 } });
    expect(seen[0]).toEqual({ maxWidth: 640 });
  });
});

describe("the registry", () => {
  it("builds a registered transform and hands back the inverse", () => {
    const dispose = registerMediaRenditionFactory("test-ocr", ({ options }) => ({
      render: async () => [textPart(String(options.text ?? ""))],
    }));
    expect(resolveMediaRendition("test-ocr", { text: "hi" })).toBeDefined();
    dispose();
    expect(resolveMediaRendition("test-ocr")).toBeUndefined();
  });

  it("returns undefined for a transform nobody registered, rather than passing through silently", () => {
    // Naming a transform no plugin provides is a misconfiguration; the caller
    // reports it. A deployment that wants untouched pictures configures nothing.
    expect(resolveMediaRendition("nobody-registered-this")).toBeUndefined();
  });
});

describe("the rendition cache", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDatabase(":memory:");
    upsertMediaRow(db, { ref: png, path: "/tmp/shot.png", sessionId: null });
  });
  afterEach(() => db.close());

  it("renders once across rounds, not once per round", async () => {
    const render = vi.fn(async () => [textPart("TOTAL 42.00")]);
    const cache = new SqliteRenditionCache(db);
    const args = { store: storeWith(), options: {}, cache };

    await applyRenditions(userWithImage, resolvedOf({ render }), args);
    const second = await applyRenditions(userWithImage, resolvedOf({ render }), args);

    expect(render).toHaveBeenCalledTimes(1);
    // And the cached answer is the real one, not an empty hit.
    expect((second[1].content as { parts: ContentPart[] }).parts[1]).toMatchObject({ text: "TOTAL 42.00" });
  });

  it("keeps entries for different settings apart", async () => {
    const render = vi.fn(async () => [textPart("x")]);
    const cache = new SqliteRenditionCache(db);
    const args = { store: storeWith(), options: {}, cache };

    await applyRenditions(userWithImage, resolvedOf({ render }, "resize:640"), args);
    await applyRenditions(userWithImage, resolvedOf({ render }, "resize:128"), args);
    expect(render).toHaveBeenCalledTimes(2);
  });

  it("serving a rendition keeps its ORIGINAL alive", async () => {
    // The trap this exists for. Retention measures "unused since", and only a
    // put refreshed the clock. Once a rendition exists it is the thing being
    // served, so the original stops being touched and is the first blob the
    // sweep deletes — breaking the one feature that depends on the original
    // outliving its cheap copy, a week later, on the request it exists to serve.
    db.prepare("UPDATE media SET last_seen_at = datetime('now', '-60 days') WHERE id = ?").run(png.id);
    const before = getMediaRow(db, png.id)?.lastSeenAt;

    const cache = new SqliteRenditionCache(db);
    const args = { store: storeWith(), options: {}, cache };
    await applyRenditions(userWithImage, resolvedOf({ render: async () => [textPart("ocr")] }), args);

    const afterWrite = getMediaRow(db, png.id)?.lastSeenAt;
    expect(afterWrite).not.toBe(before);

    // And again on a cache HIT, which is the path that actually recurs.
    db.prepare("UPDATE media SET last_seen_at = datetime('now', '-60 days') WHERE id = ?").run(png.id);
    await applyRenditions(userWithImage, resolvedOf({ render: async () => [textPart("ocr")] }), args);
    expect(getMediaRow(db, png.id)?.lastSeenAt).not.toBe(before);
  });

  it("treats an unreadable entry as a miss instead of an outage", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cache = new SqliteRenditionCache(db);
    cache.set(png.id, "test:0", [textPart("good")]);
    db.prepare("UPDATE media_renditions SET parts = ? WHERE parent_id = ?").run("{not json", png.id);

    expect(cache.get(png.id, "test:0")).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("through the agent loop", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDatabase(":memory:");
    upsertMediaRow(db, { ref: png, path: "/tmp/shot.png", sessionId: null });
  });
  afterEach(() => db.close());

  /** Captures exactly what the provider was asked to send. */
  function capturingProvider() {
    const seen: Message[][] = [];
    return {
      seen,
      provider: {
        id: "fake",
        name: "fake",
        supportsTools: true,
        async chat(params: { messages: Message[] }) {
          seen.push(params.messages);
          return { content: "ok", usage: { input: 0, output: 0 }, finishReason: "stop", toolCalls: [] };
        },
      } as unknown as AIProvider,
    };
  }

  it("sends the rendition to the provider, not the picture", async () => {
    // The regression this exists for: the rendition was computed once per round
    // and then dropped, because the per-rung params were still built from the
    // untouched history. Everything reported success and no model ever saw it.
    const { provider, seen } = capturingProvider();
    const session = newSession(db, "renditions", "m", "fake");

    await runAgentLoop(
      { text: "what is this?", media: [png] },
      {
        db,
        session,
        provider,
        tools: [],
        systemPrompt: "test",
        maxToolRounds: 5,
        mediaStore: storeWith(),
        mediaRendition: {
          resolved: resolvedOf({ render: async () => [textPart("TOTAL 42.00")] }, "ocr:test"),
          options: {},
          cache: new SqliteRenditionCache(db),
        },
      },
    );

    const parts = partsOf(seen.at(-1)!);
    expect(parts.some((p) => p.type === "media")).toBe(false);
    expect(parts.some((p) => p.type === "text" && p.text === "TOTAL 42.00")).toBe(true);
  });

  it("renders for the out-of-rounds report too, not just ordinary turns", async () => {
    // There are two places that compose a request from history: the round loop
    // and this one. Wiring only the first is how a feature works for ordinary
    // turns and silently does not for the turn that ran out of rounds — which
    // is exactly what the first version of this did.
    const seen: Message[][] = [];
    const looping = {
      id: "fake",
      name: "fake",
      supportsTools: true,
      calls: 0,
      async chat(params: { messages: Message[] }) {
        this.calls += 1;
        seen.push(params.messages);
        // Never stops on its own, so the loop exhausts its rounds.
        return {
          content: null,
          usage: { input: 0, output: 0 },
          finishReason: "tool_calls",
          toolCalls: [{ id: `c${this.calls}`, name: "noop", arguments: {} }],
        };
      },
    } as unknown as AIProvider;

    const noop = {
      name: "noop",
      description: "noop",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ output: "done" }),
    };
    const session = newSession(db, "out-of-rounds", "m", "fake");

    await runAgentLoop(
      { text: "what is this?", media: [png] },
      {
        db,
        session,
        provider: looping,
        tools: [noop],
        systemPrompt: "test",
        maxToolRounds: 1,
        mediaStore: storeWith(),
        mediaRendition: {
          resolved: resolvedOf({ render: async () => [textPart("TOTAL 42.00")] }, "ocr:test"),
          options: {},
          cache: new SqliteRenditionCache(db),
        },
      },
    );

    const parts = partsOf(seen.at(-1)!);
    expect(parts.some((p) => p.type === "media")).toBe(false);
    expect(parts.some((p) => p.type === "text" && p.text === "TOTAL 42.00")).toBe(true);
  });

  it("sends the picture when no rendition is configured", async () => {
    // The default, and the thing that must not change for anyone who configures
    // nothing at all.
    const { provider, seen } = capturingProvider();
    const session = newSession(db, "no-rendition", "m", "fake");

    await runAgentLoop(
      { text: "what is this?", media: [png] },
      { db, session, provider, tools: [], systemPrompt: "test", maxToolRounds: 5, mediaStore: storeWith() },
    );

    const parts = partsOf(seen.at(-1)!);
    expect(parts.some((p) => p.type === "media")).toBe(true);
  });

  it("leaves the session record holding the original", async () => {
    // Renditions shape the request, never the record. Turning one off has to
    // give the pictures back, and turning one on must not rewrite what earlier
    // rounds saw.
    const { provider } = capturingProvider();
    const session = newSession(db, "record", "m", "fake");

    await runAgentLoop(
      { text: "what is this?", media: [png] },
      {
        db,
        session,
        provider,
        tools: [],
        systemPrompt: "test",
        maxToolRounds: 5,
        mediaStore: storeWith(),
        mediaRendition: {
          resolved: resolvedOf({ render: async () => [textPart("TOTAL 42.00")] }, "ocr:test"),
          options: {},
          cache: new SqliteRenditionCache(db),
        },
      },
    );

    const stored = getSessionMessages(db, session.id);
    const parts = partsOf(stored);
    expect(parts.some((p) => p.type === "media")).toBe(true);
  });
});
