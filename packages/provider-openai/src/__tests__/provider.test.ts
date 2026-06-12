import { afterEach, describe, expect, it, vi } from "vitest";
import { isReasoningModel, OpenAIChatProvider } from "../provider.js";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 });
}

const CHAT_RESPONSE = {
  choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 1 },
};

afterEach(() => vi.unstubAllGlobals());

describe("isReasoningModel", () => {
  it("matches o-series and gpt-5 families, case-insensitively", () => {
    expect(isReasoningModel("o3")).toBe(true);
    expect(isReasoningModel("o4-mini")).toBe(true);
    expect(isReasoningModel("gpt-5-mini")).toBe(true);
    expect(isReasoningModel("GPT-5")).toBe(true);
    expect(isReasoningModel("gpt-4o")).toBe(false);
    expect(isReasoningModel("gpt-4.1-mini")).toBe(false);
  });

  it("honors extra configured prefixes", () => {
    expect(isReasoningModel("my-reasoner-1", ["my-reasoner"])).toBe(true);
    expect(isReasoningModel("my-reasoner-1")).toBe(false);
  });
});

describe("OpenAIChatProvider request shaping", () => {
  function spyChat(model: string, opts: ConstructorParameters<typeof OpenAIChatProvider>[0]) {
    const fetchSpy = vi.fn(async () => jsonResponse(CHAT_RESPONSE));
    vi.stubGlobal("fetch", fetchSpy);
    const provider = new OpenAIChatProvider(opts);
    return {
      fetchSpy,
      run: async (extra?: Record<string, unknown>) => {
        await provider.chat({
          model,
          messages: [{ role: "user", content: "Hi" }],
          temperature: 0.3,
          maxTokens: 1024,
          ...(extra ? { extra } : {}),
        });
        const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
        return { url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) };
      },
    };
  }

  it("sends temperature and max_completion_tokens for standard models", async () => {
    const { run } = spyChat("gpt-4.1-mini", { apiKey: "sk-test" });
    const { url, headers, body } = await run();
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect(headers.Authorization).toBe("Bearer sk-test");
    expect(body.temperature).toBe(0.3);
    expect(body.max_completion_tokens).toBe(1024);
    expect(body.max_tokens).toBeUndefined();
  });

  it("omits temperature for reasoning models", async () => {
    const { run } = spyChat("gpt-5-mini", { apiKey: "sk-test" });
    const { body } = await run();
    expect(body.temperature).toBeUndefined();
    expect(body.max_completion_tokens).toBe(1024);
  });

  it("sends org/project headers when configured", async () => {
    const { run } = spyChat("gpt-4.1-mini", { apiKey: "k", organization: "org-1", project: "proj-1" });
    const { headers } = await run();
    expect(headers["OpenAI-Organization"]).toBe("org-1");
    expect(headers["OpenAI-Project"]).toBe("proj-1");
  });

  it("passes params.extra into the body", async () => {
    const { run } = spyChat("gpt-5-mini", { apiKey: "k" });
    const { body } = await run({ reasoning_effort: "high" });
    expect(body.reasoning_effort).toBe("high");
  });
});

describe("OpenAIChatProvider responses", () => {
  it("parses tool calls and maps finish reasons", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Oslo"}' } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      ),
    );
    const provider = new OpenAIChatProvider({ apiKey: "k" });
    const resp = await provider.chat({ model: "gpt-4.1-mini", messages: [{ role: "user", content: "Weather?" }] });
    expect(resp.toolCalls).toEqual([{ id: "call_1", name: "get_weather", arguments: { city: "Oslo" } }]);
    expect(resp.finishReason).toBe("tool_calls");
    expect(resp.usage).toEqual({ input: 10, output: 5 });
  });

  it("streams deltas and accumulates tool fragments", async () => {
    const enc = new TextEncoder();
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"get_weather","arguments":"{\\"city\\""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"Oslo\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":4}}\n\n',
      "data: [DONE]\n\n",
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

    const provider = new OpenAIChatProvider({ apiKey: "k" });
    const events = [];
    for await (const ev of provider.chatStream({ model: "gpt-5-mini", messages: [{ role: "user", content: "Hi" }] })) {
      events.push(ev);
    }
    expect(events.slice(0, 2)).toEqual([
      { type: "delta", content: "Hel" },
      { type: "delta", content: "lo" },
    ]);
    expect(events[2]).toEqual({
      type: "done",
      response: {
        content: "Hello",
        toolCalls: [{ id: "call_1", name: "get_weather", arguments: { city: "Oslo" } }],
        usage: { input: 8, output: 4 },
        finishReason: "tool_calls",
      },
    });
  });

  it("lists models with auth headers", async () => {
    const fetchSpy = vi.fn(async () => jsonResponse({ data: [{ id: "gpt-5-mini" }, { id: "gpt-4.1" }] }));
    vi.stubGlobal("fetch", fetchSpy);
    const provider = new OpenAIChatProvider({ apiKey: "sk-test" });
    expect(await provider.listModels()).toEqual(["gpt-5-mini", "gpt-4.1"]);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/models");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
  });

  it("throws a readable error on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("invalid key", { status: 401 })),
    );
    const provider = new OpenAIChatProvider({ apiKey: "bad" });
    await expect(provider.chat({ model: "m", messages: [] })).rejects.toThrow(/OpenAI API error 401: invalid key/);
  });
});
