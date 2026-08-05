/**
 * Anthropic caches only what you mark. The provider marked the system prompt
 * and the tool definitions and stopped there, so the conversation — the part
 * that grows, and the bulk of the prompt — was re-read at full price on every
 * round. Against the reference deployment's traffic that was ~23% of the
 * prompt cacheable, versus ~86% for vendors that cache the whole prefix.
 *
 * Two things are easy to get wrong and both look like success from the
 * outside: a breakpoint under the minimum cacheable length is accepted and
 * silently ignored, and a breakpoint pinned to the very last message is
 * invalidated by the next turn before it can ever be read.
 */
import type { Message, ToolSchema } from "@tailored-ai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicMessagesProvider, applyHistoryCacheBreakpoint, minCacheableTokens } from "../provider.js";

afterEach(() => vi.unstubAllGlobals());

const TOOLS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get weather for a city",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    },
  },
];

const CHAT_RESPONSE = {
  content: [{ type: "text", text: "ok" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 4000 },
};

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** A conversation comfortably over the 1024-token floor. */
function longHistory(turns = 8): Message[] {
  const out: Message[] = [{ role: "system", content: "You are an agent." }];
  for (let i = 0; i < turns; i++) {
    out.push({ role: "user", content: `question ${i} ${"word ".repeat(200)}` });
    out.push({ role: "assistant", content: `answer ${i} ${"word ".repeat(200)}` });
  }
  return out;
}

async function bodyOf(messages: Message[], opts: Record<string, unknown> = {}) {
  const fetchSpy = vi.fn(async () => jsonResponse(CHAT_RESPONSE));
  vi.stubGlobal("fetch", fetchSpy);
  const provider = new AnthropicMessagesProvider({ apiKey: "k", ...opts });
  await provider.chat({ model: "claude-sonnet-5", messages, tools: TOOLS });
  return JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
}

/** Every content block carrying a breakpoint, across system, tools and messages. */
function breakpointCount(body: Record<string, unknown>): number {
  const json = JSON.stringify(body);
  return (json.match(/"cache_control"/g) ?? []).length;
}

describe("history cache breakpoint", () => {
  it("marks the history, not just system and tools", async () => {
    const body = await bodyOf(longHistory());
    const marked = body.messages.filter((m: { content: unknown }) =>
      JSON.stringify(m.content).includes("cache_control"),
    );
    expect(marked).toHaveLength(1);
  });

  it("marks the second-to-last message, so the next turn can read what this one wrote", async () => {
    const body = await bodyOf(longHistory());
    const idx = body.messages.findIndex((m: { content: unknown }) =>
      JSON.stringify(m.content).includes("cache_control"),
    );
    expect(idx).toBe(body.messages.length - 2);
  });

  it("stays inside Anthropic's four-breakpoint limit", async () => {
    const body = await bodyOf(longHistory());
    expect(breakpointCount(body)).toBeLessThanOrEqual(4);
    expect(breakpointCount(body)).toBe(3); // tools + system + history
  });

  it("skips the breakpoint below the minimum cacheable length", async () => {
    const body = await bodyOf([
      { role: "system", content: "You are an agent." },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "Bye" },
    ]);
    const marked = body.messages.filter((m: { content: unknown }) =>
      JSON.stringify(m.content).includes("cache_control"),
    );
    expect(marked).toHaveLength(0);
  });

  it("uses Haiku's higher floor", () => {
    expect(minCacheableTokens("claude-haiku-4-5")).toBe(2048);
    expect(minCacheableTokens("claude-sonnet-5")).toBe(1024);

    // A prefix between the two floors: fine for Sonnet, ignored on Haiku.
    const between = 1500;
    const msgs = () => [
      { role: "user" as const, content: "x".repeat(between * 4) },
      { role: "assistant" as const, content: "a" },
      { role: "user" as const, content: "b" },
    ];
    expect(applyHistoryCacheBreakpoint(msgs(), "claude-sonnet-5", 0)).toBe(true);
    expect(applyHistoryCacheBreakpoint(msgs(), "claude-haiku-4-5", 0)).toBe(false);
  });

  it("counts system and tools toward the floor", () => {
    const msgs = () => [
      { role: "user" as const, content: "short" },
      { role: "assistant" as const, content: "also short" },
      { role: "user" as const, content: "next" },
    ];
    expect(applyHistoryCacheBreakpoint(msgs(), "claude-sonnet-5", 0)).toBe(false);
    expect(applyHistoryCacheBreakpoint(msgs(), "claude-sonnet-5", 5000)).toBe(true);
  });

  it("marks a tool_result turn without losing the result", () => {
    const messages = [
      { role: "user" as const, content: "x".repeat(8000) },
      {
        role: "user" as const,
        content: [{ type: "tool_result" as const, tool_use_id: "tu_1", content: "42" }],
      },
      { role: "user" as const, content: "and now?" },
    ];
    expect(applyHistoryCacheBreakpoint(messages, "claude-sonnet-5", 0)).toBe(true);
    const blocks = messages[1].content as Array<Record<string, unknown>>;
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[0].content).toBe("42");
  });

  it("does nothing when there is nothing behind the last message", () => {
    const one = [{ role: "user" as const, content: "x".repeat(8000) }];
    expect(applyHistoryCacheBreakpoint(one, "claude-sonnet-5", 0)).toBe(false);
    expect(JSON.stringify(one)).not.toContain("cache_control");
  });

  it("sends no breakpoints at all when caching is off", async () => {
    const body = await bodyOf(longHistory(), { promptCaching: false });
    expect(breakpointCount(body)).toBe(0);
  });

  it("is on by default", async () => {
    const body = await bodyOf(longHistory());
    expect(breakpointCount(body)).toBeGreaterThan(0);
  });
});

describe("cache-engaged check", () => {
  it("warns once when a marked request reports neither a cache read nor a write", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = vi.fn(async () =>
      jsonResponse({ ...CHAT_RESPONSE, usage: { input_tokens: 10, output_tokens: 2 } }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const provider = new AnthropicMessagesProvider({ apiKey: "k" });
    const call = () => provider.chat({ model: "claude-sonnet-5", messages: longHistory(), tools: TOOLS });
    await call();
    await call();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("no cache read or write");
    warn.mockRestore();
  });

  it("stays quiet when the cache engaged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(CHAT_RESPONSE)),
    );

    const provider = new AnthropicMessagesProvider({ apiKey: "k" });
    await provider.chat({ model: "claude-sonnet-5", messages: longHistory(), tools: TOOLS });

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("stays quiet when caching is off — nothing was promised", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ...CHAT_RESPONSE, usage: { input_tokens: 10, output_tokens: 2 } })),
    );

    const provider = new AnthropicMessagesProvider({ apiKey: "k", promptCaching: false });
    await provider.chat({ model: "claude-sonnet-5", messages: longHistory(), tools: TOOLS });

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
