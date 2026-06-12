import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../agent/loop.js";
import { newSession } from "../agent/session.js";
import { initDatabase } from "../db/schema.js";
import type { AIProvider, ChatResponse, ChatStreamEvent } from "../providers/interface.js";
import { OpenAIProvider } from "../providers/openai.js";
import { parseSseStream } from "../providers/sse.js";

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect(stream: AsyncIterable<ChatStreamEvent>): Promise<{ deltas: string[]; done: ChatResponse }> {
  const deltas: string[] = [];
  let done: ChatResponse | undefined;
  for await (const ev of stream) {
    if (ev.type === "delta") deltas.push(ev.content);
    else done = ev.response;
  }
  if (!done) throw new Error("stream ended without done");
  return { deltas, done };
}

describe("parseSseStream", () => {
  it("parses event and data fields across chunk boundaries", async () => {
    const body = sseBody(['event: ping\ndata: {"a":', "1}\n\nda", "ta: second\n\n"]);
    const messages = [];
    for await (const msg of parseSseStream(body)) messages.push(msg);
    expect(messages).toEqual([
      { event: "ping", data: '{"a":1}' },
      { event: undefined, data: "second" },
    ]);
  });

  it("joins multiple data lines and ignores comments and CRLF", async () => {
    const body = sseBody([": comment\r\ndata: line1\r\ndata: line2\r\n\r\n"]);
    const messages = [];
    for await (const msg of parseSseStream(body)) messages.push(msg);
    expect(messages).toEqual([{ event: undefined, data: "line1\nline2" }]);
  });
});

describe("OpenAIProvider.chatStream", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(chunks: string[]): void {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(sseBody(chunks), { status: 200 })),
    );
  }

  it("yields text deltas and a final response with usage", async () => {
    stubFetch([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n',
      "data: [DONE]\n\n",
    ]);
    const provider = new OpenAIProvider("key");
    const { deltas, done } = await collect(provider.chatStream({ model: "m", messages: [] }));
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(done).toEqual({
      content: "Hello",
      toolCalls: undefined,
      usage: { input: 7, output: 2 },
      finishReason: "stop",
    });
  });

  it("accumulates tool-call fragments into complete tool calls", async () => {
    stubFetch([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc1","function":{"name":"get_","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"weather","arguments":"{\\"city\\":"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"Oslo\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    const provider = new OpenAIProvider("key");
    const { deltas, done } = await collect(provider.chatStream({ model: "m", messages: [] }));
    expect(deltas).toEqual([]);
    expect(done.toolCalls).toEqual([{ id: "tc1", name: "get_weather", arguments: { city: "Oslo" } }]);
    expect(done.finishReason).toBe("tool_calls");
    expect(done.content).toBeNull();
  });

  it("sends stream flags in the request body", async () => {
    stubFetch(["data: [DONE]\n\n"]);
    const provider = new OpenAIProvider("key");
    await collect(provider.chatStream({ model: "m", messages: [] }));
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });
});

describe("runAgentLoop onTextDelta", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  const base = {
    db: undefined as unknown as Database.Database,
    tools: [],
    extraInstructions: "",
    maxToolRounds: 5,
    maxHistoryTokens: 5000,
    temperature: 0.3,
  };

  function streamingProvider(text: string): AIProvider {
    return {
      id: "fake",
      name: "fake",
      supportsTools: true,
      async chat(): Promise<ChatResponse> {
        return { content: text, usage: { input: 0, output: 0 }, finishReason: "stop" };
      },
      async *chatStream(): AsyncIterable<ChatStreamEvent> {
        for (const piece of text.split(" ")) {
          yield { type: "delta", content: `${piece} ` };
        }
        yield {
          type: "done",
          response: { content: `${text} `, usage: { input: 1, output: 2 }, finishReason: "stop" },
        };
      },
    };
  }

  it("streams deltas to onTextDelta and uses the done response", async () => {
    const provider = streamingProvider("hello streaming world");
    const session = newSession(db, "fake-model", "fake");
    const deltas: string[] = [];
    const response = await runAgentLoop("go", {
      ...base,
      provider,
      session,
      db,
      onTextDelta: (t) => deltas.push(t),
    });
    expect(deltas).toEqual(["hello ", "streaming ", "world "]);
    expect(response).toBe("hello streaming world ");
  });

  it("falls back to chat() when the provider has no chatStream", async () => {
    const provider: AIProvider = {
      id: "fake",
      name: "fake",
      supportsTools: true,
      async chat(): Promise<ChatResponse> {
        return { content: "plain", usage: { input: 0, output: 0 }, finishReason: "stop" };
      },
    };
    const session = newSession(db, "fake-model", "fake");
    const deltas: string[] = [];
    const response = await runAgentLoop("go", {
      ...base,
      provider,
      session,
      db,
      onTextDelta: (t) => deltas.push(t),
    });
    expect(deltas).toEqual([]);
    expect(response).toBe("plain");
  });

  it("does not stream when onTextDelta is not set", async () => {
    let streamCalled = false;
    const provider: AIProvider = {
      id: "fake",
      name: "fake",
      supportsTools: true,
      async chat(): Promise<ChatResponse> {
        return { content: "blocking", usage: { input: 0, output: 0 }, finishReason: "stop" };
      },
      // biome-ignore lint/correctness/useYield: records the call then fails the test if used
      async *chatStream(): AsyncIterable<ChatStreamEvent> {
        streamCalled = true;
        throw new Error("should not be called");
      },
    };
    const session = newSession(db, "fake-model", "fake");
    const response = await runAgentLoop("go", { ...base, provider, session, db });
    expect(streamCalled).toBe(false);
    expect(response).toBe("blocking");
  });

  it("retries with non-streaming chat() after a mid-stream failure", async () => {
    let chatCalls = 0;
    const provider: AIProvider = {
      id: "fake",
      name: "fake",
      supportsTools: true,
      async chat(): Promise<ChatResponse> {
        chatCalls++;
        return { content: "recovered", usage: { input: 0, output: 0 }, finishReason: "stop" };
      },
      async *chatStream(): AsyncIterable<ChatStreamEvent> {
        yield { type: "delta", content: "partial " };
        throw new Error("connection reset");
      },
    };
    const session = newSession(db, "fake-model", "fake");
    const deltas: string[] = [];
    const response = await runAgentLoop("go", {
      ...base,
      provider,
      session,
      db,
      onTextDelta: (t) => deltas.push(t),
    });
    expect(deltas).toEqual(["partial "]);
    expect(chatCalls).toBe(1);
    expect(response).toBe("recovered");
  });
});
