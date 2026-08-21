/**
 * Model capabilities, and the pre-flight that acts on them.
 *
 * The thing most worth defending here is that this is *consulted*.
 * `AIProvider.supportsTools` spent its entire life declared on every provider,
 * hard-set to `true` by all of them, and read by nothing that changed
 * behaviour — a capability that described rather than decided. The rule adopted
 * in the design doc is that a phase adding a declaration also adds its
 * consumer, so several of these assert on behaviour rather than on the shape of
 * a returned object.
 *
 * The second theme is that `"unknown"` is a real third state. Undeclared is the
 * common case for TAI — a local gateway serves whatever was last loaded under a
 * name core cannot introspect — so resolving silence to `false` would blind a
 * vision model for want of a config line.
 */

import { describe, expect, it } from "vitest";
import type { MediaRef } from "../content/types.js";
import { mediaPart, textPart } from "../content/types.js";
import {
  adaptForCapabilities,
  DEFAULT_MEDIA_POLICY,
  type MediaPolicy,
  type ModelCapabilities,
  mimeMatches,
  resolveCapabilities,
  UNKNOWN_CAPABILITIES,
} from "../providers/capabilities.js";
import type { Message } from "../providers/interface.js";

const png: MediaRef = { id: "a".repeat(64), mimeType: "image/png", bytes: 100, name: "shot.png" };

const seeing: ModelCapabilities = {
  input: ["text/*", "image/*"],
  output: ["text/*"],
  inputBytes: { supported: true },
  inputUrl: { supported: true },
  toolResultMedia: { supported: true, mode: "inline" },
  tools: { supported: true },
};

const blind: ModelCapabilities = {
  ...seeing,
  input: ["text/*"],
  inputBytes: { supported: false },
  toolResultMedia: { supported: false },
};

const mediaMsg = (role: Message["role"], toolCallId?: string): Message => ({
  role,
  content: { parts: [textPart("look"), mediaPart(png)] },
  ...(toolCallId ? { toolCallId } : {}),
});

describe("mimeMatches", () => {
  it("matches exact types and wildcards", () => {
    expect(mimeMatches("image/png", ["image/*"])).toBe(true);
    expect(mimeMatches("image/png", ["image/png"])).toBe(true);
    expect(mimeMatches("image/png", ["*/*"])).toBe(true);
    expect(mimeMatches("image/png", ["text/*"])).toBe(false);
  });

  it("ignores parameters and casing", () => {
    expect(mimeMatches("IMAGE/PNG; q=1", ["image/*"])).toBe(true);
  });
});

describe("resolveCapabilities", () => {
  it("resolves to unknown when nobody declared anything", () => {
    // Not to `false`. This is the distinction LiteLLM loses by returning False
    // for a model it has never heard of.
    expect(resolveCapabilities()).toEqual(UNKNOWN_CAPABILITIES);
    expect(resolveCapabilities().inputBytes.supported).toBe("unknown");
  });

  it("lets config win over the provider", () => {
    // The operator is often the only one who knows what a local gateway is
    // actually serving under a given name.
    const merged = resolveCapabilities({ inputBytes: { supported: true } }, { inputBytes: { supported: false } });
    expect(merged.inputBytes.supported).toBe(true);
  });

  it("falls through to the provider for fields config omits", () => {
    const merged = resolveCapabilities(
      { input: ["image/*"] },
      { toolResultMedia: { supported: true, mode: "inline" } },
    );
    expect(merged.input).toEqual(["image/*"]);
    expect(merged.toolResultMedia.mode).toBe("inline");
  });
});

describe("adaptForCapabilities", () => {
  it("leaves a text-only conversation completely alone", () => {
    const messages: Message[] = [{ role: "user", content: "hi" }];
    const r = adaptForCapabilities(messages, blind);
    expect(r.messages[0]).toBe(messages[0]);
    expect(r.notes).toEqual([]);
  });

  it("passes media through to a model that accepts it", () => {
    const r = adaptForCapabilities([mediaMsg("user")], seeing);
    expect(r.notes).toEqual([]);
    expect(r.messages[0]).toEqual(mediaMsg("user"));
  });

  it("degrades to a placeholder for a model that cannot see, and says so", () => {
    // The rule: a part that does not reach the model leaves a warning or a
    // placeholder. Never nothing.
    const r = adaptForCapabilities([mediaMsg("user")], blind);
    expect(r.notes).toHaveLength(1);
    const content = r.messages[0].content;
    if (typeof content === "string" || content === null) throw new Error("expected parts");
    expect(content.parts.every((p) => p.type === "text")).toBe(true);
    expect(JSON.stringify(content)).toContain("shot.png");
  });

  it("sends unknown capability by default rather than assuming the worst", () => {
    // TAI carries providers/quirks.ts precisely to learn a model's limits from
    // its refusals, so trying is information rather than a dead end.
    const r = adaptForCapabilities([mediaMsg("user")], UNKNOWN_CAPABILITIES, DEFAULT_MEDIA_POLICY);
    expect(r.notes).toEqual([]);
    expect(r.skip).toBeUndefined();
  });

  it("degrades unknown capability when the policy says to", () => {
    const policy: MediaPolicy = { onUnsupported: "degrade", onUnknown: "degrade" };
    const r = adaptForCapabilities([mediaMsg("user")], UNKNOWN_CAPABILITIES, policy);
    expect(r.notes).toHaveLength(1);
  });

  it("asks to skip the rung when the policy prefers a different model", () => {
    const policy: MediaPolicy = { onUnsupported: "skip-rung", onUnknown: "try" };
    const r = adaptForCapabilities([mediaMsg("user")], blind, policy);
    expect(r.skip).toBeTruthy();
  });

  it("throws when the policy says a mismatch is an error", () => {
    const policy: MediaPolicy = { onUnsupported: "error", onUnknown: "try" };
    expect(() => adaptForCapabilities([mediaMsg("user")], blind, policy)).toThrow(/cannot accept media/);
  });

  it("keeps tool-result media inline where the API allows it", () => {
    const r = adaptForCapabilities([mediaMsg("tool", "t1")], seeing);
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].role).toBe("tool");
    expect(r.notes).toEqual([]);
  });

  it("moves tool-result media into a following user turn for a follow-up provider", () => {
    // vLLM and OpenAI Chat Completions take only a string in a tool message.
    const followUp: ModelCapabilities = { ...seeing, toolResultMedia: { supported: true, mode: "follow-up" } };
    const r = adaptForCapabilities([mediaMsg("tool", "t1")], followUp);
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0].role).toBe("tool");
    expect(r.messages[1].role).toBe("user");
    expect(r.notes[0]).toContain("following user turn");
  });

  it("labels the promoted turn as tool output rather than something the user said", () => {
    // The move costs something real: media leaves the quarantined tool-output
    // position for the trusted one. The marker is what keeps its origin visible.
    const followUp: ModelCapabilities = { ...seeing, toolResultMedia: { supported: true, mode: "follow-up" } };
    const r = adaptForCapabilities([mediaMsg("tool", "t1")], followUp);
    expect(JSON.stringify(r.messages[1].content)).toContain("not sent by the user");
  });

  it("strips media from the tool message it promoted, leaving the pairing intact", () => {
    const followUp: ModelCapabilities = { ...seeing, toolResultMedia: { supported: true, mode: "follow-up" } };
    const r = adaptForCapabilities([mediaMsg("tool", "t1")], followUp);
    expect(r.messages[0].toolCallId).toBe("t1");
    const content = r.messages[0].content;
    if (typeof content === "string" || content === null) throw new Error("expected parts");
    expect(content.parts.some((p) => p.type === "media")).toBe(false);
  });

  it("degrades tool-result media for a model that refuses it outright", () => {
    const noToolMedia: ModelCapabilities = { ...seeing, toolResultMedia: { supported: false } };
    const r = adaptForCapabilities([mediaMsg("tool", "t1")], noToolMedia);
    expect(r.messages).toHaveLength(1);
    expect(r.notes[0]).toContain("degraded");
  });

  it("rejects a type outside the declared input list even when bytes are accepted", () => {
    const imagesOnly: ModelCapabilities = { ...seeing, input: ["text/*", "image/*"] };
    const wav: MediaRef = { id: "b".repeat(64), mimeType: "audio/wav", bytes: 10, name: "clip.wav" };
    const msg: Message = { role: "user", content: { parts: [mediaPart(wav)] } };
    const r = adaptForCapabilities([msg], imagesOnly);
    expect(r.notes).toHaveLength(1);
  });
});
