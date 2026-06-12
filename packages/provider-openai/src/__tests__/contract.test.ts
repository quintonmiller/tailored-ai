/**
 * Contract coverage via core's shared provider suite (#226). The fetch stub
 * answers blocking chat, streaming chat (`body.stream === true`), and model
 * listing, so all optional-capability legs of the suite run.
 */
import { runProviderContractSuite } from "@tailored-ai/core/testing";
import { afterAll, vi } from "vitest";
import { OpenAIChatProvider } from "../provider.js";

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

vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
  if (String(url).endsWith("/models")) {
    return new Response(JSON.stringify({ data: [{ id: "gpt-5-mini" }] }), { status: 200 });
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
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    }),
    { status: 200 },
  );
});

afterAll(() => vi.unstubAllGlobals());

runProviderContractSuite({
  name: "openai (plugin)",
  harness: {
    build: () => new OpenAIChatProvider({ apiKey: "sk-test" }),
    params: { model: "gpt-5-mini" },
  },
});
