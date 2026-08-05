/**
 * The Responses API exists in this plugin for one reason: on
 * `/v1/chat/completions` the 5.4+ generations refuse function tools alongside
 * any reasoning effort, and TAI always sends tools. These tests pin the wire
 * shape and the recovery ladder.
 *
 * Every error string below is a verbatim capture from the live API on
 * 2026-08-05 — the wording differs from chat-completions for the same
 * condition, which is exactly what a mock written from memory would have
 * gotten wrong.
 */

import type { Message, ToolSchema } from "@tailored-ai/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nearestEffort, OpenAIResponsesProvider, toResponsesInput, toResponsesTools } from "../responses.js";

const TOOLS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "ping",
      description: "Ping.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
];

const EFFORT_400 = JSON.stringify({
  error: {
    message:
      "Unsupported value: 'none' is not supported with the 'gpt-5-mini' model. Supported values are: 'minimal', 'low', 'medium', and 'high'.",
    type: "invalid_request_error",
    param: "reasoning.effort",
    code: "unsupported_value",
  },
});

const ONLY_MEDIUM_400 = JSON.stringify({
  error: {
    message:
      "Unsupported value: 'high' is not supported with the 'gpt-5.3-chat-latest' model. Supported values are: 'medium'.",
    type: "invalid_request_error",
    param: "reasoning.effort",
    code: "unsupported_value",
  },
});

const SUMMARY_400 = JSON.stringify({
  error: {
    message:
      "Your organization must be verified to generate reasoning summaries. Please go to: https://platform.openai.com/settings",
    type: "invalid_request_error",
    param: "reasoning.summary",
  },
});

/** A minimal successful response carrying one text message. */
const textResponse = (text = "ok") => ({
  status: "completed",
  output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
  usage: { input_tokens: 10, output_tokens: 5 },
});

let sent: Array<Record<string, unknown>>;

function mockFetch(responder: (body: Record<string, unknown>, call: number) => { ok: boolean; body?: unknown }) {
  return vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    sent.push(body);
    const verdict = responder(body, sent.length);
    if (!verdict.ok) {
      const text = typeof verdict.body === "string" ? verdict.body : JSON.stringify(verdict.body);
      return { ok: false, status: 400, text: async () => text } as unknown as Response;
    }
    return { ok: true, json: async () => verdict.body ?? textResponse() } as unknown as Response;
  });
}

const provider = (opts: Record<string, unknown> = {}) => new OpenAIResponsesProvider({ apiKey: "k", ...opts });
const ask = (p: OpenAIResponsesProvider, over: Record<string, unknown> = {}) =>
  p.chat({ model: "gpt-5.6-luna", messages: [{ role: "user", content: "hi" }], tools: TOOLS, ...over });

beforeEach(() => {
  sent = [];
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("input conversion", () => {
  it("turns a tool result into a function_call_output keyed by call_id", () => {
    const messages: Message[] = [{ role: "tool", content: "42", toolCallId: "call_1" }];
    expect(toResponsesInput(messages)).toEqual([{ type: "function_call_output", call_id: "call_1", output: "42" }]);
  });

  it("lifts assistant tool calls to top-level function_call items", () => {
    const messages: Message[] = [
      { role: "assistant", content: null, toolCalls: [{ id: "call_1", name: "ping", arguments: { a: 1 } }] },
    ];
    expect(toResponsesInput(messages)).toEqual([
      { type: "function_call", call_id: "call_1", name: "ping", arguments: '{"a":1}' },
    ]);
  });

  it("splits an assistant turn that both spoke and called a tool", () => {
    // One chat-completions message is two Responses items; collapsing them
    // would drop the spoken half.
    const messages: Message[] = [
      { role: "assistant", content: "let me check", toolCalls: [{ id: "c1", name: "ping", arguments: {} }] },
    ];
    const input = toResponsesInput(messages) as Array<Record<string, unknown>>;
    expect(input).toHaveLength(2);
    expect(input[0]).toEqual({ role: "assistant", content: "let me check" });
    expect(input[1]).toMatchObject({ type: "function_call", call_id: "c1" });
  });

  it("passes plain roles through", () => {
    const messages: Message[] = [
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ];
    expect(toResponsesInput(messages)).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ]);
  });

  it("replays reasoning immediately before the calls it produced", () => {
    const items = [{ type: "reasoning", id: "r1", encrypted_content: "blob" }];
    const messages: Message[] = [
      { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "ping", arguments: {} }] },
    ];
    const input = toResponsesInput(messages, (id) => (id === "c1" ? items : undefined)) as Array<
      Record<string, unknown>
    >;
    expect(input[0]).toMatchObject({ type: "reasoning", encrypted_content: "blob" });
    expect(input[1]).toMatchObject({ type: "function_call" });
  });

  it("declares tools flat, not nested under `function`", () => {
    expect(toResponsesTools(TOOLS)).toEqual([
      { type: "function", name: "ping", description: "Ping.", parameters: TOOLS[0].function.parameters },
    ]);
  });
});

describe("nearestEffort", () => {
  it("answers 'none' with the cheapest available rather than the first listed", () => {
    // The live error lists 'minimal','low','medium','high' in that order, but
    // "I asked for none" must not be answered with "high".
    expect(nearestEffort("none", ["minimal", "low", "medium", "high"])).toBe("minimal");
  });

  it("moves down to the only supported level", () => {
    expect(nearestEffort("high", ["medium"])).toBe("medium");
  });

  it("breaks ties toward the cheaper level", () => {
    expect(nearestEffort("medium", ["low", "high"])).toBe("low");
  });

  it("returns nothing when the model named no alternatives", () => {
    expect(nearestEffort("high", [])).toBeUndefined();
  });
});

describe("request shape", () => {
  it("omits temperature for reasoning models and sends max_output_tokens", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({ ok: true })),
    );
    await ask(provider(), { temperature: 0.3, maxTokens: 2048 });

    expect(sent[0].temperature).toBeUndefined();
    expect(sent[0].max_output_tokens).toBe(2048);
    expect(sent[0].max_completion_tokens).toBeUndefined();
  });

  it("keeps temperature for a non-reasoning model", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({ ok: true })),
    );
    await provider().chat({ model: "gpt-4.1", messages: [{ role: "user", content: "hi" }], temperature: 0.7 });

    expect(sent[0].temperature).toBe(0.7);
  });

  it("does not let OpenAI retain responses unless asked", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({ ok: true })),
    );
    await ask(provider());
    expect(sent[0].store).toBe(false);

    sent = [];
    await ask(provider({ store: true }));
    expect(sent[0].store).toBe(true);
  });

  it("maps thinking off to effort none and asks for a summary", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({ ok: true })),
    );
    await ask(provider(), { thinking: "off" });
    expect(sent[0].reasoning).toEqual({ effort: "none", summary: "auto" });
  });

  it("sends no reasoning block for thinking auto with summaries off", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({ ok: true })),
    );
    await ask(provider({ reasoningSummary: "off" }), { thinking: "auto" });
    expect(sent[0].reasoning).toBeUndefined();
  });
});

describe("response parsing", () => {
  it("reads text, tool calls, reasoning and usage out of output[]", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({
        ok: true,
        body: {
          status: "completed",
          output: [
            {
              type: "reasoning",
              id: "r1",
              encrypted_content: "blob",
              summary: [{ type: "summary_text", text: "thinking" }],
            },
            { type: "function_call", call_id: "c1", name: "ping", arguments: '{"a":1}' },
          ],
          usage: { input_tokens: 93, output_tokens: 36 },
        },
      })),
    );
    const r = await ask(provider());

    expect(r.finishReason).toBe("tool_calls");
    expect(r.toolCalls).toEqual([{ id: "c1", name: "ping", arguments: { a: 1 } }]);
    expect(r.reasoning).toBe("thinking");
    expect(r.usage).toEqual({ input: 93, output: 36 });
  });

  it("reports truncation as length", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({
        ok: true,
        body: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [], usage: {} },
      })),
    );
    expect((await ask(provider())).finishReason).toBe("length");
  });

  it("survives a tool call truncated mid-arguments", async () => {
    // Losing the whole turn to a JSON parse error is worse than an empty
    // argument object the tool layer can reject with a useful message.
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({
        ok: true,
        body: {
          output: [{ type: "function_call", call_id: "c1", name: "ping", arguments: '{"a":' }],
          usage: {},
        },
      })),
    );
    const r = await ask(provider());
    expect(r.toolCalls).toEqual([{ id: "c1", name: "ping", arguments: {} }]);
  });
});

describe("effort recovery", () => {
  it("substitutes the nearest supported effort and says so once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      mockFetch((body) => {
        const effort = (body.reasoning as { effort?: string } | undefined)?.effort;
        return effort === "none" ? { ok: false, body: EFFORT_400 } : { ok: true };
      }),
    );
    const p = provider();
    await p.chat({ model: "gpt-5-mini", messages: [{ role: "user", content: "hi" }], tools: TOOLS, thinking: "off" });

    expect(sent.map((b) => (b.reasoning as { effort?: string })?.effort)).toEqual(["none", "minimal"]);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("does not accept"))).toHaveLength(1);
  });

  it("remembers, so the next call is right first time", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      mockFetch((body) => {
        const effort = (body.reasoning as { effort?: string } | undefined)?.effort;
        return effort === "high" ? { ok: false, body: ONLY_MEDIUM_400 } : { ok: true };
      }),
    );
    const p = provider();
    const call = () =>
      p.chat({ model: "gpt-5.3-chat-latest", messages: [{ role: "user", content: "hi" }], thinking: "high" });
    await call();
    sent = [];
    await call();

    expect(sent).toHaveLength(1);
    expect((sent[0].reasoning as { effort?: string }).effort).toBe("medium");
  });

  it("drops the effort when the model names no alternative", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      mockFetch((body) => {
        const effort = (body.reasoning as { effort?: string } | undefined)?.effort;
        return effort
          ? {
              ok: false,
              body: JSON.stringify({
                error: { message: "Unsupported value: 'high' is not supported.", param: "reasoning.effort" },
              }),
            }
          : { ok: true };
      }),
    );
    await ask(provider({ reasoningSummary: "off" }), { thinking: "high" });

    expect(sent).toHaveLength(2);
    expect(sent[1].reasoning).toBeUndefined();
  });

  it("drops summaries an unverified org cannot generate, and warns once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      mockFetch((body) => {
        const summary = (body.reasoning as { summary?: string } | undefined)?.summary;
        return summary ? { ok: false, body: SUMMARY_400 } : { ok: true };
      }),
    );
    const p = provider();
    await p.chat({ model: "o4-mini", messages: [{ role: "user", content: "hi" }], thinking: "high" });
    await p.chat({ model: "o4-mini", messages: [{ role: "user", content: "hi" }], thinking: "high" });

    expect((sent[0].reasoning as { summary?: string }).summary).toBe("auto");
    expect((sent[1].reasoning as { summary?: string }).summary).toBeUndefined();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("not verified"))).toHaveLength(1);
  });

  it("rethrows a 400 it does not recognise, without a second request", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({
        ok: false,
        body: JSON.stringify({ error: { message: "context_length_exceeded", param: "input" } }),
      })),
    );
    await expect(ask(provider())).rejects.toThrow(/context_length_exceeded/);
    expect(sent).toHaveLength(1);
  });

  it("does not retry a non-400", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, text: async () => "upstream boom" }) as unknown as Response),
    );
    await expect(ask(provider())).rejects.toThrow(/500/);
  });
});

describe("reasoning replay", () => {
  it("feeds the previous turn's reasoning back with the tool result", async () => {
    const first = {
      output: [
        { type: "reasoning", id: "r1", encrypted_content: "blob" },
        { type: "function_call", call_id: "c1", name: "ping", arguments: "{}" },
      ],
      usage: {},
    };
    vi.stubGlobal(
      "fetch",
      mockFetch((_b, n) => ({ ok: true, body: n === 1 ? first : textResponse() })),
    );

    const p = provider();
    const r = await ask(p);
    await p.chat({
      model: "gpt-5.6-luna",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: null, toolCalls: r.toolCalls },
        { role: "tool", content: "pong", toolCallId: "c1" },
      ],
      tools: TOOLS,
    });

    const input = sent[1].input as Array<Record<string, unknown>>;
    expect(input.some((i) => i.type === "reasoning" && i.encrypted_content === "blob")).toBe(true);
  });
});

describe("streaming", () => {
  function sseBody(events: Array<Record<string, unknown>>) {
    const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
    return {
      ok: true,
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(text));
          c.close();
        },
      }),
    } as unknown as Response;
  }

  it("yields text and reasoning deltas, then a done built from response.completed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseBody([
          { type: "response.created" },
          { type: "response.reasoning_summary_text.delta", delta: "think" },
          { type: "response.output_text.delta", delta: "hello " },
          { type: "response.output_text.delta", delta: "world" },
          {
            type: "response.completed",
            response: {
              output: [{ type: "message", content: [{ type: "output_text", text: "hello world" }] }],
              usage: { input_tokens: 3, output_tokens: 4 },
            },
          },
        ]),
      ),
    );

    const events = [];
    for await (const ev of provider().chatStream({
      model: "gpt-5.6-luna",
      messages: [{ role: "user", content: "hi" }],
    })) {
      events.push(ev);
    }

    expect(events.filter((e) => e.type === "delta").map((e) => (e as { content: string }).content)).toEqual([
      "hello ",
      "world",
    ]);
    expect(events.filter((e) => e.type === "reasoning")).toHaveLength(1);

    const done = events.at(-1);
    expect(done?.type).toBe("done");
    // The documented invariant: concatenated deltas equal done.response.content.
    expect(done && "response" in done && done.response.content).toBe("hello world");
    expect(done && "response" in done && done.response.reasoning).toBe("think");
    expect(done && "response" in done && done.response.usage).toEqual({ input: 3, output: 4 });
  });

  it("surfaces tool calls from the final payload rather than partial deltas", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sseBody([
          { type: "response.function_call_arguments.delta", delta: '{"a' },
          {
            type: "response.completed",
            response: {
              output: [{ type: "function_call", call_id: "c1", name: "ping", arguments: '{"a":1}' }],
              usage: {},
            },
          },
        ]),
      ),
    );

    const events = [];
    for await (const ev of provider().chatStream({
      model: "gpt-5.6-luna",
      messages: [{ role: "user", content: "hi" }],
    })) {
      events.push(ev);
    }

    // Consumers need complete arguments, so nothing partial may escape.
    expect(events.filter((e) => e.type === "delta")).toHaveLength(0);
    const done = events.at(-1);
    expect(done && "response" in done && done.response.toolCalls).toEqual([
      { id: "c1", name: "ping", arguments: { a: 1 } },
    ]);
  });

  it("throws when the stream ends without a completed response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseBody([{ type: "response.created" }])),
    );
    const run = async () => {
      for await (const _ of provider().chatStream({ model: "gpt-5.6-luna", messages: [] })) {
        // drain
      }
    };
    await expect(run()).rejects.toThrow(/without a completed response/);
  });

  it("surfaces a failed response as an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseBody([{ type: "response.failed", response: { error: { message: "model exploded" } } }])),
    );
    const run = async () => {
      for await (const _ of provider().chatStream({ model: "gpt-5.6-luna", messages: [] })) {
        // drain
      }
    };
    await expect(run()).rejects.toThrow(/model exploded/);
  });
});
