import type { ConverseCommand, ConverseCommandOutput } from "@aws-sdk/client-bedrock-runtime";
import type { Message, ToolSchema } from "@tailored-ai/core";
import { describe, expect, it, vi } from "vitest";
import {
  BedrockProvider,
  mapStopReason,
  parseConverseResponse,
  toConverseMessages,
  toConverseTools,
} from "../provider.js";

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

describe("toConverseMessages", () => {
  it("extracts leading system messages into top-level system blocks", () => {
    const messages: Message[] = [
      { role: "system", content: "You are helpful." },
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hi" },
    ];
    const { system, messages: out } = toConverseMessages(messages);
    expect(system).toEqual([{ text: "You are helpful." }, { text: "Be brief." }]);
    expect(out).toEqual([{ role: "user", content: [{ text: "Hi" }] }]);
  });

  it("converts mid-conversation system messages to user turns", () => {
    const messages: Message[] = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
      { role: "system", content: "Config reloaded." },
    ];
    const { messages: out } = toConverseMessages(messages);
    expect(out[2]).toEqual({ role: "user", content: [{ text: "Config reloaded." }] });
  });

  it("converts assistant tool calls to toolUse blocks, keeping text first", () => {
    const messages: Message[] = [
      { role: "user", content: "Weather in Tokyo?" },
      {
        role: "assistant",
        content: "Checking.",
        toolCalls: [{ id: "tu_1", name: "get_weather", arguments: { city: "Tokyo" } }],
      },
    ];
    const { messages: out } = toConverseMessages(messages);
    expect(out[1]).toEqual({
      role: "assistant",
      content: [
        { text: "Checking." },
        { toolUse: { toolUseId: "tu_1", name: "get_weather", input: { city: "Tokyo" } } },
      ],
    });
  });

  it("converts tool results to user toolResult blocks", () => {
    const messages: Message[] = [{ role: "tool", content: "22C, sunny", toolCallId: "tu_1" }];
    const { messages: out } = toConverseMessages(messages);
    expect(out).toEqual([
      {
        role: "user",
        content: [{ toolResult: { toolUseId: "tu_1", content: [{ text: "22C, sunny" }] } }],
      },
    ]);
  });

  it("merges adjacent same-role messages into one turn", () => {
    const messages: Message[] = [
      { role: "tool", content: "result A", toolCallId: "tu_1" },
      { role: "tool", content: "result B", toolCallId: "tu_2" },
      { role: "user", content: "Now summarize." },
    ];
    const { messages: out } = toConverseMessages(messages);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user");
    expect(out[0].content).toHaveLength(3);
  });

  it("skips messages with empty content (Converse rejects empty text blocks)", () => {
    const messages: Message[] = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: null },
      { role: "user", content: "Still there?" },
    ];
    const { messages: out } = toConverseMessages(messages);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      role: "user",
      content: [{ text: "Hi" }, { text: "Still there?" }],
    });
  });
});

describe("toConverseTools", () => {
  it("maps ToolSchema to Converse toolSpec shape", () => {
    expect(toConverseTools(TOOLS)).toEqual([
      {
        toolSpec: {
          name: "get_weather",
          description: "Get weather for a city",
          inputSchema: { json: TOOLS[0].function.parameters },
        },
      },
    ]);
  });
});

describe("mapStopReason", () => {
  it("maps Converse stop reasons to internal finish reasons", () => {
    expect(mapStopReason("tool_use")).toBe("tool_calls");
    expect(mapStopReason("max_tokens")).toBe("length");
    expect(mapStopReason("end_turn")).toBe("stop");
    expect(mapStopReason("stop_sequence")).toBe("stop");
    expect(mapStopReason(undefined)).toBe("stop");
  });
});

describe("parseConverseResponse", () => {
  it("parses a text response with usage", () => {
    const data = {
      output: { message: { role: "assistant", content: [{ text: "Hello!" }] } },
      stopReason: "end_turn",
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
    } as unknown as ConverseCommandOutput;
    expect(parseConverseResponse(data)).toEqual({
      content: "Hello!",
      toolCalls: undefined,
      usage: { input: 12, output: 5 },
      finishReason: "stop",
    });
  });

  it("parses toolUse blocks into tool calls", () => {
    const data = {
      output: {
        message: {
          role: "assistant",
          content: [
            { text: "Let me check." },
            { toolUse: { toolUseId: "tu_9", name: "get_weather", input: { city: "Oslo" } } },
          ],
        },
      },
      stopReason: "tool_use",
      usage: { inputTokens: 30, outputTokens: 11, totalTokens: 41 },
    } as unknown as ConverseCommandOutput;
    const parsed = parseConverseResponse(data);
    expect(parsed.content).toBe("Let me check.");
    expect(parsed.toolCalls).toEqual([{ id: "tu_9", name: "get_weather", arguments: { city: "Oslo" } }]);
    expect(parsed.finishReason).toBe("tool_calls");
  });

  it("tolerates a missing output/usage", () => {
    const parsed = parseConverseResponse({} as ConverseCommandOutput);
    expect(parsed).toEqual({
      content: null,
      toolCalls: undefined,
      usage: { input: 0, output: 0 },
      finishReason: "stop",
    });
  });
});

describe("BedrockProvider.chat", () => {
  const RESPONSE = {
    output: { message: { role: "assistant", content: [{ text: "OK" }] } },
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  } as unknown as ConverseCommandOutput;

  function makeProvider() {
    const send = vi.fn(async () => RESPONSE);
    const provider = new BedrockProvider({ client: { send } as never });
    return { provider, send };
  }

  function sentInput(send: ReturnType<typeof vi.fn>) {
    return (send.mock.calls[0][0] as ConverseCommand).input;
  }

  it("sends modelId, messages, and default inference config", async () => {
    const { provider, send } = makeProvider();
    const resp = await provider.chat({
      model: "us.amazon.nova-micro-v1:0",
      messages: [{ role: "user", content: "Say OK" }],
    });
    const input = sentInput(send);
    expect(input.modelId).toBe("us.amazon.nova-micro-v1:0");
    expect(input.messages).toEqual([{ role: "user", content: [{ text: "Say OK" }] }]);
    expect(input.inferenceConfig).toEqual({ maxTokens: 4096, temperature: 0.3 });
    expect(input.system).toBeUndefined();
    expect(input.toolConfig).toBeUndefined();
    expect(resp.content).toBe("OK");
  });

  it("passes system, tools, params, and extra through", async () => {
    const { provider, send } = makeProvider();
    await provider.chat({
      model: "m",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "Hi" },
      ],
      tools: TOOLS,
      temperature: 0.7,
      maxTokens: 256,
      extra: { top_k: 50 },
    });
    const input = sentInput(send);
    expect(input.system).toEqual([{ text: "Be brief." }]);
    expect(input.toolConfig).toEqual({ tools: toConverseTools(TOOLS) });
    expect(input.inferenceConfig).toEqual({ maxTokens: 256, temperature: 0.7 });
    expect(input.additionalModelRequestFields).toEqual({ top_k: 50 });
  });

  it("wraps SDK errors with the model id for context", async () => {
    const send = vi.fn(async () => {
      throw new Error("ValidationException: on-demand throughput isn't supported");
    });
    const provider = new BedrockProvider({ client: { send } as never });
    await expect(provider.chat({ model: "amazon.nova-micro-v1:0", messages: [] })).rejects.toThrow(
      /Bedrock Converse error for model amazon\.nova-micro-v1:0: ValidationException/,
    );
  });
});

describe("BedrockProvider.chatStream", () => {
  function streamOf(events: unknown[]) {
    return (async function* () {
      for (const e of events) yield e;
    })();
  }

  function makeStreamProvider(events: unknown[]) {
    const send = vi.fn(async () => ({ stream: streamOf(events) }));
    return { provider: new BedrockProvider({ client: { send } as never }), send };
  }

  async function collect(provider: BedrockProvider, model = "us.amazon.nova-micro-v1:0") {
    const out = [];
    for await (const ev of provider.chatStream({ model, messages: [{ role: "user", content: "Hi" }] })) {
      out.push(ev);
    }
    return out;
  }

  it("yields text deltas then one done; concatenated deltas equal done content", async () => {
    const { provider } = makeStreamProvider([
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hello" } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: " world" } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: "end_turn" } },
      { metadata: { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 }, metrics: {} } },
    ]);
    const events = await collect(provider);

    expect(events).toEqual([
      { type: "delta", content: "Hello" },
      { type: "delta", content: " world" },
      {
        type: "done",
        response: {
          content: "Hello world",
          toolCalls: undefined,
          usage: { input: 5, output: 2 },
          finishReason: "stop",
        },
      },
    ]);
  });

  it("accumulates toolUse input fragments and surfaces complete tool calls on done", async () => {
    const { provider } = makeStreamProvider([
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Checking." } } },
      { contentBlockStart: { contentBlockIndex: 1, start: { toolUse: { toolUseId: "tu_1", name: "get_weather" } } } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: '{"city"' } } } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: ':"Oslo"}' } } } },
      { contentBlockStop: { contentBlockIndex: 1 } },
      { messageStop: { stopReason: "tool_use" } },
      { metadata: { usage: { inputTokens: 30, outputTokens: 11, totalTokens: 41 }, metrics: {} } },
    ]);
    const events = await collect(provider);

    expect(events[0]).toEqual({ type: "delta", content: "Checking." });
    const done = events[events.length - 1];
    expect(done).toEqual({
      type: "done",
      response: {
        content: "Checking.",
        toolCalls: [{ id: "tu_1", name: "get_weather", arguments: { city: "Oslo" } }],
        usage: { input: 30, output: 11 },
        finishReason: "tool_calls",
      },
    });
  });

  it("throws on mid-stream exception events", async () => {
    const { provider } = makeStreamProvider([
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "partial" } } },
      { modelStreamErrorException: { name: "ModelStreamErrorException", message: "stream broke" } },
    ]);
    await expect(collect(provider)).rejects.toThrow(/Bedrock ConverseStream error for model .*stream broke/);
  });

  it("throws when the response carries no stream", async () => {
    const send = vi.fn(async () => ({}));
    const provider = new BedrockProvider({ client: { send } as never });
    await expect(collect(provider)).rejects.toThrow(/response contained no stream/);
  });

  it("wraps send errors with the model id for context", async () => {
    const send = vi.fn(async () => {
      throw new Error("ThrottlingException: slow down");
    });
    const provider = new BedrockProvider({ client: { send } as never });
    await expect(collect(provider, "amazon.nova-micro-v1:0")).rejects.toThrow(
      /Bedrock ConverseStream error for model amazon\.nova-micro-v1:0: ThrottlingException/,
    );
  });
});
