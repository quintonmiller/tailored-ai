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

  it("no dialect (default none) ignores thinking", async () => {
    const body = captureBody();
    const { provider } = buildOpenAICompatibleProvider({ baseUrl: "http://x/v1", defaultModel: "m" }, "vllm");
    await provider.chat({ ...params, thinking: "high" });
    expect(body().reasoning_effort).toBeUndefined();
    expect(body().chat_template_kwargs).toBeUndefined();
  });
});
