/**
 * The GPT-5.4+ generation rejects `reasoning_effort` alongside function tools on
 * /chat/completions, and older reasoning models reject the `"none"` that the
 * newer ones require. Since TAI always sends tools, an agent on gpt-5.4/5.5/5.6
 * with any thinking level was a guaranteed 400 — and one with none configured
 * was *also* a 400, because omitting the field is not the same as sending
 * `"none"`.
 *
 * Measured 2026-08-05:
 *
 * | model | `"none"` | real effort + tools |
 * |---|---|---|
 * | gpt-5, gpt-5-mini, o3, o4-mini | rejected | accepted |
 * | gpt-5.1, gpt-5.2 | accepted | accepted |
 * | gpt-5.3-chat-latest | rejected | rejected |
 * | gpt-5.4, 5.4-mini, 5.5, 5.6-* | accepted | rejected |
 *
 * No prefix rule covers that table, so the provider learns from the API's own
 * 400s. These tests pin the ladder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAIChatProvider } from "../provider.js";

const TOOLS = [
  {
    type: "function" as const,
    function: { name: "ping", description: "Ping.", parameters: { type: "object", properties: {} } },
  },
];

const EFFORT_WITH_TOOLS_400 =
  "OpenAI API error 400: Function tools with reasoning_effort are not supported for gpt-5.6-luna in /v1/chat/completions.";
const NO_NONE_400 =
  "OpenAI API error 400: Unsupported value: 'reasoning_effort' does not support 'none' with this model.";

/** Bodies the provider actually sent, in order. */
let sent: Array<Record<string, unknown>>;

function mockFetch(responder: (body: Record<string, unknown>, call: number) => { ok: boolean; text?: string }) {
  return vi.fn(async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    sent.push(body);
    const verdict = responder(body, sent.length);
    if (!verdict.ok) {
      return { ok: false, status: 400, text: async () => verdict.text ?? "bad request" } as unknown as Response;
    }
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    } as unknown as Response;
  });
}

const provider = () => new OpenAIChatProvider({ apiKey: "k" });
const call = (p: OpenAIChatProvider, thinking?: "off" | "low" | "high") =>
  p.chat({ model: "gpt-5.6-luna", messages: [{ role: "user", content: "hi" }], tools: TOOLS, thinking });

beforeEach(() => {
  sent = [];
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("reasoning_effort recovery", () => {
  it('retries with "none" when the model refuses effort alongside tools', async () => {
    // The blocker as it actually presents: nothing configured, no field sent,
    // and the request still 400s because omitting is not the same as "none".
    vi.stubGlobal(
      "fetch",
      mockFetch((body) =>
        body.reasoning_effort === "none" ? { ok: true } : { ok: false, text: EFFORT_WITH_TOOLS_400 },
      ),
    );
    const p = provider();
    const res = await call(p);

    expect(res.content).toBe("ok");
    expect(sent).toHaveLength(2);
    expect(sent[0].reasoning_effort).toBeUndefined();
    expect(sent[1].reasoning_effort).toBe("none");
  });

  it("remembers, so the second call gets the right shape first time", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch((body) =>
        body.reasoning_effort === "none" ? { ok: true } : { ok: false, text: EFFORT_WITH_TOOLS_400 },
      ),
    );
    const p = provider();
    await call(p);
    sent = [];
    await call(p);

    expect(sent).toHaveLength(1);
    expect(sent[0].reasoning_effort).toBe("none");
  });

  it("drops a requested effort it cannot satisfy, and says so once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      mockFetch((body) =>
        body.reasoning_effort === "none" ? { ok: true } : { ok: false, text: EFFORT_WITH_TOOLS_400 },
      ),
    );
    const p = provider();
    await call(p, "high");
    await call(p, "high");

    expect(sent[0].reasoning_effort).toBe("high");
    expect(sent[1].reasoning_effort).toBe("none");
    // Silently downgrading reasoning would be the wrong kind of quiet: the
    // request succeeds, so nothing else would ever reveal it.
    const about = warn.mock.calls.filter((c) => String(c[0]).includes("cannot combine reasoning"));
    expect(about).toHaveLength(1);
    expect(String(about[0][0])).toContain("Responses API");
  });

  it("does not warn when no reasoning was asked for", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      mockFetch((body) =>
        body.reasoning_effort === "none" ? { ok: true } : { ok: false, text: EFFORT_WITH_TOOLS_400 },
      ),
    );
    await call(provider(), "off");
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("cannot combine reasoning"))).toHaveLength(0);
  });

  it('falls back to omitting the field for a model that rejects "none" too', async () => {
    // gpt-5.3-chat-latest rejects both. The ladder must terminate on the shape
    // that works rather than oscillating between the two rejected ones.
    vi.stubGlobal(
      "fetch",
      mockFetch((body) => {
        if (body.reasoning_effort === "none") return { ok: false, text: NO_NONE_400 };
        if (body.reasoning_effort !== undefined) return { ok: false, text: EFFORT_WITH_TOOLS_400 };
        return { ok: true };
      }),
    );
    const p = provider();
    const res = await p.chat({
      model: "gpt-5.3-chat-latest",
      messages: [{ role: "user", content: "hi" }],
      tools: TOOLS,
      thinking: "high",
    });

    expect(res.content).toBe("ok");
    expect(sent.map((b) => b.reasoning_effort)).toEqual(["high", "none", undefined]);
  });

  it("uses the effort the error says is supported rather than dropping reasoning", async () => {
    // gpt-5.3-chat-latest answers "does not support 'high' … Supported values
    // are: 'medium'." Honouring that keeps reasoning on at the only level the
    // model has, which is closer to what was asked for than turning it off.
    vi.stubGlobal(
      "fetch",
      mockFetch((body) =>
        body.reasoning_effort === "medium"
          ? { ok: true }
          : {
              ok: false,
              text: `OpenAI API error 400: Unsupported value: 'reasoning_effort' does not support '${body.reasoning_effort}' with this model. Supported values are: 'medium'.`,
            },
      ),
    );
    const p = provider();
    const res = await p.chat({
      model: "gpt-5.3-chat-latest",
      messages: [{ role: "user", content: "hi" }],
      tools: TOOLS,
      thinking: "high",
    });

    expect(res.content).toBe("ok");
    expect(sent.map((b) => b.reasoning_effort)).toEqual(["high", "medium"]);
  });

  it("rethrows a 400 that is not about reasoning_effort", async () => {
    // Retrying an unrelated 400 with a different body turns one clear failure
    // into two confusing ones.
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({ ok: false, text: "OpenAI API error 400: context_length_exceeded" })),
    );
    await expect(call(provider())).rejects.toThrow(/context_length_exceeded/);
    expect(sent).toHaveLength(1);
  });

  it("leaves a model that accepts the configured effort alone", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({ ok: true })),
    );
    const p = provider();
    await p.chat({
      model: "gpt-5-mini",
      messages: [{ role: "user", content: "hi" }],
      tools: TOOLS,
      thinking: "low",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].reasoning_effort).toBe("low");
  });
});
