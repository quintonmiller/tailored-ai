import { afterAll, describe, expect, it, vi } from "vitest";
import type { ChatResponse } from "../providers/interface.js";
import { OpenAIProvider } from "../providers/openai.js";
import { assertValidChatResponse, runProviderContractSuite } from "../testing/provider-contract.js";

/**
 * Dogfood: the built-in provider runs through the provider contract suite
 * with a stubbed fetch. The stubs answer blocking chat, streaming chat
 * (`body.stream === true` — exercised once the providers implement
 * chatStream), and model listing, so the optional-capability legs of the
 * suite activate automatically as capabilities land.
 */

function sse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const openaiFetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const href = String(url);
  if (href.endsWith("/models")) {
    return json({ data: [{ id: "model-a" }, { id: "model-b" }] });
  }
  const body = JSON.parse((init?.body as string) ?? "{}") as { stream?: boolean };
  if (body.stream) {
    return sse([
      'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n',
      "data: [DONE]\n\n",
    ]);
  }
  return json({
    choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 1 },
  });
};

vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
  return openaiFetch(url, init);
});

afterAll(() => vi.unstubAllGlobals());

runProviderContractSuite({
  name: "openai_compatible (stubbed)",
  harness: {
    build: () => new OpenAIProvider(undefined, "http://openai.test/v1", { id: "openai_compatible" }),
  },
});

describe("listModels", () => {
  it("OpenAIProvider parses /models ids", async () => {
    const provider = new OpenAIProvider(undefined, "http://openai.test/v1");
    await expect(provider.listModels()).resolves.toEqual(["model-a", "model-b"]);
  });
});

describe("assertValidChatResponse", () => {
  const valid: ChatResponse = {
    content: "hi",
    usage: { input: 1, output: 1 },
    finishReason: "stop",
  };

  it("accepts a valid response", () => {
    expect(() => assertValidChatResponse(valid)).not.toThrow();
  });

  it("rejects an unknown finishReason", () => {
    expect(() => assertValidChatResponse({ ...valid, finishReason: "banana" as never })).toThrow();
  });

  it("rejects missing usage numbers", () => {
    expect(() => assertValidChatResponse({ ...valid, usage: undefined as never })).toThrow();
  });

  it("rejects malformed tool calls", () => {
    expect(() =>
      assertValidChatResponse({
        ...valid,
        toolCalls: [{ id: "x", name: "", arguments: {} }],
      }),
    ).toThrow();
  });
});
