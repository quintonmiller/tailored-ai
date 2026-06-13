import type { Message, ToolSchema } from "@tailored-ai/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnthropicMessagesProvider, mapStopReason, parseApiResponse, toApiMessages, toApiTools } from "../provider.js";

const TOOLS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get weather for a city",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "get_time",
      description: "Get current time",
      parameters: { type: "object", properties: {} },
    },
  },
];

afterEach(() => vi.unstubAllGlobals());

describe("toApiMessages", () => {
  it("extracts leading system messages into top-level blocks", () => {
    const messages: Message[] = [
      { role: "system", content: "You are helpful." },
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hi" },
    ];
    const { system, messages: out } = toApiMessages(messages, false);
    expect(system).toEqual([
      { type: "text", text: "You are helpful." },
      { type: "text", text: "Be brief." },
    ]);
    expect(out).toEqual([{ role: "user", content: "Hi" }]);
  });

  it("marks the last system block with a cache breakpoint when caching", () => {
    const messages: Message[] = [
      { role: "system", content: "You are helpful." },
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hi" },
    ];
    const { system } = toApiMessages(messages, true);
    expect(system?.[0].cache_control).toBeUndefined();
    expect(system?.[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("converts tool rounds: assistant toolCalls and tool results", () => {
    const messages: Message[] = [
      { role: "user", content: "Weather in Oslo?" },
      {
        role: "assistant",
        content: "Checking.",
        toolCalls: [{ id: "tu_1", name: "get_weather", arguments: { city: "Oslo" } }],
      },
      { role: "tool", content: "12C", toolCallId: "tu_1" },
    ];
    const { messages: out } = toApiMessages(messages, false);
    expect(out[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Checking." },
        { type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "Oslo" } },
      ],
    });
    expect(out[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: "12C" }],
    });
  });

  it("merges adjacent same-role messages and converts mid-conversation system to user", () => {
    const messages: Message[] = [
      { role: "user", content: "Hi" },
      { role: "system", content: "Config reloaded." },
      { role: "user", content: "Still there?" },
    ];
    const { messages: out } = toApiMessages(messages, false);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user");
    expect(out[0].content).toHaveLength(3);
  });
});

describe("toApiTools", () => {
  it("converts schemas; breakpoint on the last tool only when caching", () => {
    expect(toApiTools(TOOLS, false).every((t) => t.cache_control === undefined)).toBe(true);
    const cached = toApiTools(TOOLS, true);
    expect(cached[0].cache_control).toBeUndefined();
    expect(cached[1].cache_control).toEqual({ type: "ephemeral" });
    expect(cached[0]).toMatchObject({ name: "get_weather", input_schema: TOOLS[0].function.parameters });
  });
});

describe("parseApiResponse", () => {
  it("sums cache reads/writes into input usage", () => {
    const parsed = parseApiResponse({
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 50 },
    });
    expect(parsed.usage).toEqual({ input: 160, output: 5 });
  });

  it("maps stop reasons", () => {
    expect(mapStopReason("tool_use")).toBe("tool_calls");
    expect(mapStopReason("max_tokens")).toBe("length");
    expect(mapStopReason("end_turn")).toBe("stop");
    expect(mapStopReason(undefined)).toBe("stop");
  });

  it("captures thinking blocks into reasoning (#254)", () => {
    const parsed = parseApiResponse({
      content: [
        { type: "thinking", thinking: "Let me reason. " },
        { type: "thinking", thinking: "Almost there." },
        { type: "text", text: "Answer" },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 2 },
    });
    expect(parsed.content).toBe("Answer");
    expect(parsed.reasoning).toBe("Let me reason. Almost there.");
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 });
}

const CHAT_RESPONSE = {
  content: [{ type: "text", text: "OK" }],
  stop_reason: "end_turn",
  usage: { input_tokens: 3, output_tokens: 1 },
};

describe("AnthropicMessagesProvider", () => {
  it("sends version, beta headers, and the configured max_tokens default", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(CHAT_RESPONSE));
    vi.stubGlobal("fetch", fetchSpy);

    const provider = new AnthropicMessagesProvider({
      apiKey: "sk-ant-test",
      version: "2024-10-22",
      betas: ["context-1m-2025-08-07", "token-efficient-tools"],
      defaultMaxTokens: 8192,
    });
    await provider.chat({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "Hi" }] });

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-test");
    expect(headers["anthropic-version"]).toBe("2024-10-22");
    expect(headers["anthropic-beta"]).toBe("context-1m-2025-08-07,token-efficient-tools");
    const body = JSON.parse(init.body as string);
    expect(body.max_tokens).toBe(8192);
  });

  it("omits the beta header when no betas configured", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(CHAT_RESPONSE));
    vi.stubGlobal("fetch", fetchSpy);

    const provider = new AnthropicMessagesProvider({ apiKey: "k" });
    await provider.chat({ model: "m", messages: [{ role: "user", content: "Hi" }] });
    const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["anthropic-beta"]).toBeUndefined();
  });

  it("passes params.extra into the request body", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(CHAT_RESPONSE));
    vi.stubGlobal("fetch", fetchSpy);

    const provider = new AnthropicMessagesProvider({ apiKey: "k" });
    await provider.chat({
      model: "m",
      messages: [{ role: "user", content: "Hi" }],
      extra: { thinking: { type: "enabled", budget_tokens: 2048 }, top_k: 40 },
    });
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
    expect(body.top_k).toBe(40);
  });

  it("maps thinking to a budget, bumps max_tokens, and drops temperature (#254)", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(CHAT_RESPONSE));
    vi.stubGlobal("fetch", fetchSpy);

    const provider = new AnthropicMessagesProvider({ apiKey: "k", defaultMaxTokens: 4096, defaultThinking: "high" });
    await provider.chat({ model: "m", messages: [{ role: "user", content: "Hi" }] });
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 16000 });
    expect(body.max_tokens).toBe(16000 + 4096); // budget + max(baseMax, 4096)
    expect(body.max_tokens).toBeGreaterThan(16000); // API requires max_tokens > budget
    expect(body.temperature).toBeUndefined(); // rejected when thinking is on
  });

  it("a per-call thinking level overrides the default; off disables (#254)", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(CHAT_RESPONSE));
    vi.stubGlobal("fetch", fetchSpy);

    const provider = new AnthropicMessagesProvider({ apiKey: "k", defaultThinking: "high" });
    await provider.chat({ model: "m", messages: [{ role: "user", content: "Hi" }], thinking: "off" });
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.thinking).toBeUndefined();
    expect(body.temperature).toBe(0.3); // kept when thinking is off
  });

  it("adds cache breakpoints to system and tools when promptCaching is on", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse(CHAT_RESPONSE));
    vi.stubGlobal("fetch", fetchSpy);

    const provider = new AnthropicMessagesProvider({ apiKey: "k", promptCaching: true });
    await provider.chat({
      model: "m",
      messages: [
        { role: "system", content: "You are an agent." },
        { role: "user", content: "Hi" },
      ],
      tools: TOOLS,
    });
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(body.tools[1].cache_control).toEqual({ type: "ephemeral" });
  });

  it("streams text deltas, accumulates tool fragments, and assembles usage", async () => {
    const enc = new TextEncoder();
    const chunks = [
      'event: message_start\ndata: {"message":{"usage":{"input_tokens":10,"cache_read_input_tokens":90}}}\n\n',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"Check"}}\n\n',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"text_delta","text":"ing."}}\n\n',
      'event: content_block_start\ndata: {"index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"get_weather"}}\n\n',
      'event: content_block_delta\ndata: {"index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\""}}\n\n',
      'event: content_block_delta\ndata: {"index":1,"delta":{"type":"input_json_delta","partial_json":":\\"Oslo\\"}"}}\n\n',
      'event: message_delta\ndata: {"delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}\n\n',
      "event: message_stop\ndata: {}\n\n",
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                for (const chunk of chunks) c.enqueue(enc.encode(chunk));
                c.close();
              },
            }),
            { status: 200 },
          ),
      ),
    );

    const provider = new AnthropicMessagesProvider({ apiKey: "k" });
    const events = [];
    for await (const ev of provider.chatStream({ model: "m", messages: [{ role: "user", content: "Hi" }] })) {
      events.push(ev);
    }

    expect(events.slice(0, 2)).toEqual([
      { type: "delta", content: "Check" },
      { type: "delta", content: "ing." },
    ]);
    expect(events[2]).toEqual({
      type: "done",
      response: {
        content: "Checking.",
        toolCalls: [{ id: "tu_1", name: "get_weather", arguments: { city: "Oslo" } }],
        usage: { input: 100, output: 7 },
        finishReason: "tool_calls",
      },
    });
  });

  it("streams thinking_delta as reasoning events and on done (#254)", async () => {
    const enc = new TextEncoder();
    const chunks = [
      'event: message_start\ndata: {"message":{"usage":{"input_tokens":5}}}\n\n',
      'event: content_block_start\ndata: {"index":0,"content_block":{"type":"thinking"}}\n\n',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"thinking_delta","thinking":"Hmm "}}\n\n',
      'event: content_block_delta\ndata: {"index":0,"delta":{"type":"thinking_delta","thinking":"yes."}}\n\n',
      'event: content_block_delta\ndata: {"index":1,"delta":{"type":"text_delta","text":"Answer"}}\n\n',
      'event: message_delta\ndata: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
      "event: message_stop\ndata: {}\n\n",
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(c) {
                for (const chunk of chunks) c.enqueue(enc.encode(chunk));
                c.close();
              },
            }),
            { status: 200 },
          ),
      ),
    );

    const provider = new AnthropicMessagesProvider({ apiKey: "k" });
    const events = [];
    for await (const ev of provider.chatStream({ model: "m", messages: [{ role: "user", content: "Hi" }] })) {
      events.push(ev);
    }
    expect(events.filter((e) => e.type === "reasoning")).toEqual([
      { type: "reasoning", content: "Hmm " },
      { type: "reasoning", content: "yes." },
    ]);
    const done = events.at(-1);
    expect(done?.type === "done" && done.response.reasoning).toBe("Hmm yes.");
    expect(done?.type === "done" && done.response.content).toBe("Answer");
  });

  it("lists models via /v1/models", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ data: [{ id: "claude-haiku-4-5" }, { id: "claude-opus-4-8" }] }));
    vi.stubGlobal("fetch", fetchSpy);

    const provider = new AnthropicMessagesProvider({ apiKey: "k" });
    expect(await provider.listModels()).toEqual(["claude-haiku-4-5", "claude-opus-4-8"]);
    expect(fetchSpy.mock.calls[0][0]).toBe("https://api.anthropic.com/v1/models");
  });

  it("throws a readable error on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rate limited", { status: 429 })),
    );
    const provider = new AnthropicMessagesProvider({ apiKey: "k" });
    await expect(provider.chat({ model: "m", messages: [] })).rejects.toThrow(/Anthropic API error 429: rate limited/);
  });
});
