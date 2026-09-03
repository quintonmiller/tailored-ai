/**
 * The capability pre-flight, exercised through `chatWithFallback`.
 *
 * These are the tests that stop this from becoming a second `supportsTools` —
 * a field declared everywhere, set by everyone, and read by nothing. Each one
 * asserts what the *provider actually received*, not what the capability
 * object said.
 *
 * Before this existed, `chatWithFallback`'s catch treated a 4xx as a fine
 * reason to try the next rung, so "this model has no eyes" was
 * indistinguishable from a rate limit and the answer to both was to spend
 * another round-trip finding out.
 */

import { describe, expect, it, vi } from "vitest";
import { chatWithFallback, type ModelCandidate } from "../agent/loop.js";
import type { MediaRef } from "../content/types.js";
import { contentParts, mediaPart, textPart } from "../content/types.js";
import { adaptForCapabilities, type PartialCapabilities, resolveCapabilities } from "../providers/capabilities.js";
import type { AIProvider, ChatParams, ChatResponse, Message } from "../providers/interface.js";

const png: MediaRef = { id: "c".repeat(64), mimeType: "image/png", bytes: 64, name: "shot.png" };

function provider(opts: { caps?: PartialCapabilities; supportsTools?: boolean; id?: string } = {}): AIProvider & {
  seen: ChatParams[];
} {
  const seen: ChatParams[] = [];
  return {
    id: opts.id ?? "p",
    name: opts.id ?? "p",
    supportsTools: opts.supportsTools ?? true,
    seen,
    ...(opts.caps ? { capabilities: () => opts.caps as PartialCapabilities } : {}),
    async chat(params: ChatParams): Promise<ChatResponse> {
      seen.push(params);
      return {
        content: "ok",
        usage: { input: 1, output: 1 },
        finishReason: "stop",
      };
    },
  };
}

const candidate = (p: AIProvider, extra: Partial<ModelCandidate> = {}): ModelCandidate => ({
  provider: p,
  model: "m1",
  label: "rung",
  ...extra,
});

const withImage: Message[] = [{ role: "user", content: { parts: [textPart("look"), mediaPart(png)] } }];

const SEES: PartialCapabilities = {
  input: ["text/*", "image/*"],
  inputBytes: { supported: true },
  toolResultMedia: { supported: true, mode: "inline" },
};
const BLIND: PartialCapabilities = {
  input: ["text/*"],
  inputBytes: { supported: false },
  toolResultMedia: { supported: false },
};

describe("capability pre-flight in chatWithFallback", () => {
  it("sends media untouched to a model that declares it can see", async () => {
    const p = provider({ caps: SEES });
    await chatWithFallback([candidate(p)], { messages: withImage });
    const content = p.seen[0].messages[0].content;
    if (typeof content === "string" || content === null) throw new Error("expected parts");
    expect(content.parts.some((x) => x.type === "media")).toBe(true);
  });

  it("degrades media before the request when the model declares it cannot", async () => {
    // The point: the provider never receives something it said it cannot take,
    // so the 400 that used to teach us this never happens.
    const p = provider({ caps: BLIND });
    await chatWithFallback([candidate(p)], { messages: withImage });
    const content = p.seen[0].messages[0].content;
    if (typeof content === "string" || content === null) throw new Error("expected parts");
    expect(content.parts.some((x) => x.type === "media")).toBe(false);
    expect(JSON.stringify(content)).toContain("shot.png");
  });

  it("lets a per-rung config override beat the provider's own answer", async () => {
    // A local gateway serves whatever was last loaded under a given name, so
    // the operator is frequently the only party who knows.
    const p = provider({ caps: BLIND });
    await chatWithFallback([candidate(p, { capabilities: SEES })], { messages: withImage });
    const content = p.seen[0].messages[0].content;
    if (typeof content === "string" || content === null) throw new Error("expected parts");
    expect(content.parts.some((x) => x.type === "media")).toBe(true);
  });

  it("skips a rung that cannot see and answers from the next one", async () => {
    const blindP = provider({ caps: BLIND, id: "blind" });
    const seeingP = provider({ caps: SEES, id: "seeing" });
    const r = await chatWithFallback(
      [candidate(blindP, { label: "blind" }), candidate(seeingP, { label: "seeing" })],
      { messages: withImage },
      undefined,
      undefined,
      { onUnsupported: "skip-rung", onUnknown: "try" },
    );
    expect(blindP.seen).toHaveLength(0);
    expect(seeingP.seen).toHaveLength(1);
    expect(r.candidate.label).toBe("seeing");
  });

  it("explains an empty chain by naming the policy, not a missing config block", async () => {
    const blindP = provider({ caps: BLIND });
    await expect(
      chatWithFallback([candidate(blindP)], { messages: withImage }, undefined, undefined, {
        onUnsupported: "skip-rung",
        onUnknown: "try",
      }),
    ).rejects.toThrow(/skipped by the media capability check/);
  });

  it("sends undeclared media rather than assuming a model is blind", async () => {
    // Undeclared is the normal state, not the exceptional one — auto-discovery
    // is unavailable exactly where it would matter.
    const p = provider({});
    await chatWithFallback([candidate(p)], { messages: withImage });
    const content = p.seen[0].messages[0].content;
    if (typeof content === "string" || content === null) throw new Error("expected parts");
    expect(content.parts.some((x) => x.type === "media")).toBe(true);
  });

  it("leaves a text-only request byte-identical", async () => {
    const p = provider({ caps: BLIND });
    const messages: Message[] = [{ role: "user", content: "hi" }];
    await chatWithFallback([candidate(p)], { messages });
    expect(p.seen[0].messages).toEqual(messages);
  });
});

describe("supportsTools finally decides something", () => {
  it("skips a provider that cannot call tools when the request has tools", async () => {
    // Declared on every provider since forever, hard-set to true by all of
    // them, and read by nothing that changed behaviour until now.
    const noTools = provider({ supportsTools: false, id: "notools" });
    const yesTools = provider({ supportsTools: true, id: "yestools" });
    const r = await chatWithFallback(
      [candidate(noTools, { label: "notools" }), candidate(yesTools, { label: "yestools" })],
      {
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "t", description: "d", parameters: {} } }],
      },
    );
    expect(noTools.seen).toHaveLength(0);
    expect(r.candidate.label).toBe("yestools");
  });

  it("still uses a tool-less provider for a request without tools", async () => {
    const noTools = provider({ supportsTools: false });
    await chatWithFallback([candidate(noTools)], { messages: [{ role: "user", content: "hi" }] });
    expect(noTools.seen).toHaveLength(1);
  });

  it("prefers an explicit tools capability over the legacy flag", async () => {
    const p = provider({ supportsTools: false, caps: { tools: { supported: true } } });
    await chatWithFallback([candidate(p)], {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "t", description: "d", parameters: {} } }],
    });
    expect(p.seen).toHaveLength(1);
  });
});

describe("warnings", () => {
  it("logs what it changed, so a degraded request is never silent", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await chatWithFallback([candidate(provider({ caps: BLIND }))], { messages: withImage });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("degraded to text"));
    } finally {
      warn.mockRestore();
    }
  });
});

describe("follow-up media does not split a tool-call block", () => {
  // The provider shape that triggers it: takes media, but not inside a tool
  // result, and documents the follow-up-user-turn workaround.
  const FOLLOWUP: PartialCapabilities = {
    input: ["text/*", "image/*"],
    inputBytes: { supported: true },
    // supported: the provider takes this media — just not in tool position,
    // which is what `mode: "follow-up"` describes.
    toolResultMedia: { supported: true, mode: "follow-up" },
  };

  /** One assistant turn opening two tool calls; the first returns media. */
  const twoCallTurn: Message[] = [
    { role: "user", content: "check both" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "call_a", name: "screenshot", arguments: "{}" },
        { id: "call_b", name: "read", arguments: "{}" },
      ],
    },
    { role: "tool", toolCallId: "call_a", content: { parts: [textPart("shot"), mediaPart(png)] } },
    { role: "tool", toolCallId: "call_b", content: "plain text result" },
  ];

  const adapt = (msgs: Message[]) =>
    adaptForCapabilities(msgs, resolveCapabilities(FOLLOWUP), { onUnsupported: "degrade", onUnknown: "degrade" });

  it("keeps every tool result adjacent to the assistant that called it", () => {
    const { messages } = adapt(twoCallTurn);
    const roles = messages.map((m) => m.role);
    const assistantAt = roles.indexOf("assistant");
    // Everything between the assistant and the last tool result must be a tool
    // message — this is the adjacency DeepSeek and OpenAI enforce.
    const lastTool = roles.lastIndexOf("tool");
    const between = roles.slice(assistantAt + 1, lastTool + 1);
    expect(between.every((r) => r === "tool")).toBe(true);
  });

  it("answers both tool calls, so nothing is orphaned", () => {
    const { messages } = adapt(twoCallTurn);
    const answered = messages.filter((m) => m.role === "tool").map((m) => m.toolCallId);
    expect(answered).toEqual(["call_a", "call_b"]);
  });

  it("still delivers the media, after the block rather than inside it", () => {
    const { messages } = adapt(twoCallTurn);
    const last = messages.at(-1);
    expect(last?.role).toBe("user");
    const parts = contentParts(last?.content);
    expect(parts.some((p) => p.type === "media")).toBe(true);
    expect(parts.some((p) => p.type === "text" && p.text.includes("not sent by the user"))).toBe(true);
  });

  it("a single-call turn behaves as before", () => {
    const one: Message[] = [
      { role: "user", content: "check" },
      { role: "assistant", content: "", toolCalls: [{ id: "call_a", name: "screenshot", arguments: "{}" }] },
      { role: "tool", toolCallId: "call_a", content: { parts: [textPart("shot"), mediaPart(png)] } },
    ];
    const roles = adapt(one).messages.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "user"]);
  });
});
