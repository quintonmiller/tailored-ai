/**
 * Tests for the provider-agnostic reasoning control seam (#254): the generic
 * mappers, the OpenAIProvider thinkingMap/defaultThinking plumbing, and the
 * openai_compatible factory's thinking/thinkingDialect config.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpenAICompatibleProvider } from "../providers/factories.js";
import type { ChatParams } from "../providers/interface.js";
import { OpenAIProvider } from "../providers/openai.js";
import {
  effortTemplateMap,
  enableThinkingTemplateMap,
  isThinkingLevel,
  reasoningEffortThinkingMap,
  THINKING_LEVELS,
} from "../providers/thinking.js";

const params: ChatParams = { model: "m", messages: [] };

describe("generic thinking mappers (#254)", () => {
  it("reasoningEffortThinkingMap passes low/medium/high, omits off/auto", () => {
    expect(reasoningEffortThinkingMap("low", params)).toEqual({ reasoning_effort: "low" });
    expect(reasoningEffortThinkingMap("high", params)).toEqual({ reasoning_effort: "high" });
    expect(reasoningEffortThinkingMap("off", params)).toBeUndefined();
    expect(reasoningEffortThinkingMap("auto", params)).toBeUndefined();
  });

  it("enableThinkingTemplateMap toggles enable_thinking, leaves auto to the server", () => {
    expect(enableThinkingTemplateMap("high", params)).toEqual({ chat_template_kwargs: { enable_thinking: true } });
    expect(enableThinkingTemplateMap("off", params)).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(enableThinkingTemplateMap("auto", params)).toBeUndefined();
  });

  /**
   * The template these serve accepts `low`, `medium` and `xhigh`, and raises
   * `Unexpected reasoning effort` on anything else — so core's `high` has to be
   * translated, not forwarded. Getting this wrong is not a quality regression,
   * it is a 400 on every request.
   */
  it("effortTemplateMap sends the template's rungs, mapping high to xhigh", () => {
    expect(effortTemplateMap("low", params)).toEqual({
      chat_template_kwargs: { enable_thinking: true, reasoning_effort: "low" },
    });
    expect(effortTemplateMap("medium", params)).toEqual({
      chat_template_kwargs: { enable_thinking: true, reasoning_effort: "medium" },
    });
    expect(effortTemplateMap("high", params)).toEqual({
      chat_template_kwargs: { enable_thinking: true, reasoning_effort: "xhigh" },
    });
  });

  it("effortTemplateMap never sends a rung the template would reject", () => {
    const accepted = new Set(["low", "medium", "xhigh"]);
    for (const level of THINKING_LEVELS) {
      const kwargs = effortTemplateMap(level, params)?.chat_template_kwargs as
        | { reasoning_effort?: string }
        | undefined;
      const effort = kwargs?.reasoning_effort;
      if (effort !== undefined) expect(accepted, `level ${level}`).toContain(effort);
    }
  });

  it("effortTemplateMap turns thinking off without naming an effort", () => {
    // The template only reads `reasoning_effort` inside its thinking branch;
    // sending one alongside `enable_thinking: false` would be contradictory.
    expect(effortTemplateMap("off", params)).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(effortTemplateMap("auto", params)).toBeUndefined();
  });

  it("the plain vllm dialect stays free of effort", () => {
    // Templates without the kwarg raise on unexpected kwargs, so the existing
    // dialect must keep sending exactly what it sent before.
    for (const level of THINKING_LEVELS) {
      const fragment = enableThinkingTemplateMap(level, params);
      const kwargs = fragment?.chat_template_kwargs as Record<string, unknown> | undefined;
      if (kwargs) expect(Object.keys(kwargs)).toEqual(["enable_thinking"]);
    }
  });

  it("isThinkingLevel / THINKING_LEVELS", () => {
    for (const lvl of THINKING_LEVELS) expect(isThinkingLevel(lvl)).toBe(true);
    expect(isThinkingLevel("loud")).toBe(false);
    expect(isThinkingLevel(true)).toBe(false);
  });
});

describe("OpenAIProvider thinking control", () => {
  afterEach(() => vi.unstubAllGlobals());

  function captureBody(): () => Record<string, unknown> {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: {} }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return () => JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
  }

  it("maps ChatParams.thinking through the configured mapper", async () => {
    const body = captureBody();
    const provider = new OpenAIProvider("k", undefined, { thinkingMap: reasoningEffortThinkingMap });
    await provider.chat({ ...params, thinking: "high" });
    expect(body().reasoning_effort).toBe("high");
  });

  it("falls back to defaultThinking when the call omits a level", async () => {
    const body = captureBody();
    const provider = new OpenAIProvider("k", undefined, {
      thinkingMap: reasoningEffortThinkingMap,
      defaultThinking: "medium",
    });
    await provider.chat(params);
    expect(body().reasoning_effort).toBe("medium");
  });

  it("a per-call extra wins over the mapped fragment", async () => {
    const body = captureBody();
    const provider = new OpenAIProvider("k", undefined, { thinkingMap: reasoningEffortThinkingMap });
    await provider.chat({ ...params, thinking: "high", extra: { reasoning_effort: "low" } });
    expect(body().reasoning_effort).toBe("low");
  });

  it("ignores thinking when no mapper is set (generic endpoint)", async () => {
    const body = captureBody();
    const provider = new OpenAIProvider("k");
    await provider.chat({ ...params, thinking: "high" });
    expect(body().reasoning_effort).toBeUndefined();
  });
});

describe("openai_compatible factory thinking config (#254)", () => {
  afterEach(() => vi.unstubAllGlobals());

  function captureBody(): () => Record<string, unknown> {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: {} }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return () => JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
  }

  it("thinkingDialect:openai + default thinking maps reasoning_effort", async () => {
    const body = captureBody();
    const { provider } = buildOpenAICompatibleProvider(
      { baseUrl: "http://x/v1", defaultModel: "m", thinkingDialect: "openai", thinking: "low" },
      "vllm",
    );
    await provider.chat(params);
    expect(body().reasoning_effort).toBe("low");
  });

  it("thinkingDialect:vllm maps the template kwarg", async () => {
    const body = captureBody();
    const { provider } = buildOpenAICompatibleProvider(
      { baseUrl: "http://x/v1", defaultModel: "m", thinkingDialect: "vllm" },
      "vllm",
    );
    await provider.chat({ ...params, thinking: "off" });
    expect(body().chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("thinkingDialect:vllm_effort reaches the wire with the mapped rung", async () => {
    const body = captureBody();
    const { provider } = buildOpenAICompatibleProvider(
      { baseUrl: "http://x/v1", defaultModel: "m", thinkingDialect: "vllm_effort", thinking: "medium" },
      "vllm",
    );
    await provider.chat(params);
    expect(body().chat_template_kwargs).toEqual({ enable_thinking: true, reasoning_effort: "medium" });
  });

  it("no dialect (default none) ignores thinking", async () => {
    const body = captureBody();
    const { provider } = buildOpenAICompatibleProvider({ baseUrl: "http://x/v1", defaultModel: "m" }, "vllm");
    await provider.chat({ ...params, thinking: "high" });
    expect(body().reasoning_effort).toBeUndefined();
    expect(body().chat_template_kwargs).toBeUndefined();
  });
});
