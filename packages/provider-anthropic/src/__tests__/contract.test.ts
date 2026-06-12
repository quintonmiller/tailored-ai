/**
 * Contract coverage via core's shared provider suite (#226). The fetch stub
 * answers blocking chat, streaming chat (`body.stream === true`), and model
 * listing, so all optional-capability legs of the suite run.
 */
import { runProviderContractSuite } from "@tailored-ai/core/testing";
import { afterAll, vi } from "vitest";
import { AnthropicMessagesProvider } from "../provider.js";

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
  if (String(url).endsWith("/v1/models")) {
    return new Response(JSON.stringify({ data: [{ id: "claude-haiku-4-5" }] }), { status: 200 });
  }
  const body = JSON.parse((init?.body as string) ?? "{}") as { stream?: boolean };
  if (body.stream) {
    return sse([
      'event: message_start\ndata: {"message":{"usage":{"input_tokens":3}}}\n\n',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"OK"}}\n\n',
      'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      "event: message_stop\ndata: {}\n\n",
    ]);
  }
  return new Response(
    JSON.stringify({
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 1 },
    }),
    { status: 200 },
  );
});

afterAll(() => vi.unstubAllGlobals());

runProviderContractSuite({
  name: "anthropic (plugin)",
  harness: {
    build: () => new AnthropicMessagesProvider({ apiKey: "sk-ant-test", promptCaching: true }),
    params: { model: "claude-haiku-4-5" },
  },
});
