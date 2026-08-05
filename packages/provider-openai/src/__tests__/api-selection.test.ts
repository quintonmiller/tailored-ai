/**
 * Which endpoint a request needs is a property of the model, and the model is
 * not fixed when the provider is built — an agent can pin one, a per-call
 * override can name another, and a fallback-chain rung can carry a third.
 * Deciding at construction time from `defaultModel` would send an overridden
 * model to the wrong endpoint, which is the same shape of bug as an agent's
 * `provider:` being silently ignored.
 */
import type { AIProvider, ChatParams, ChatResponse } from "@tailored-ai/core";
import { describe, expect, it } from "vitest";
import { needsResponsesApi, type OpenAIConfig, selectApi, validateConfig } from "../index.js";
import { OpenAIRouterProvider } from "../router.js";

const cfg = (over: Partial<OpenAIConfig> = {}): OpenAIConfig => ({
  apiKey: "k",
  defaultModel: "gpt-5-mini",
  ...over,
});

describe("needsResponsesApi", () => {
  it.each([
    ["gpt-5.6-luna", true],
    ["gpt-5.6-terra", true],
    ["gpt-5.5", true],
    ["gpt-5.4-mini", true],
    ["gpt-5.3-codex", true],
    // chat-completions serves these correctly, so moving them would be churn.
    ["gpt-5-mini", false],
    ["gpt-5.3-chat-latest", false],
    ["gpt-4.1", false],
    ["o4-mini", false],
  ])("%s -> %s", (model, expected) => {
    expect(needsResponsesApi(model)).toBe(expected);
  });

  it("can be extended without a release", () => {
    expect(needsResponsesApi("gpt-6-preview", ["gpt-6"])).toBe(true);
  });
});

describe("selectApi", () => {
  it("routes only the models that need it when left on auto", () => {
    expect(selectApi(cfg(), "gpt-5.6-luna")).toBe("responses");
    expect(selectApi(cfg(), "gpt-5-mini")).toBe("chat");
  });

  it("honours an explicit pin in both directions", () => {
    expect(selectApi(cfg({ api: "chat" }), "gpt-5.6-luna")).toBe("chat");
    expect(selectApi(cfg({ api: "responses" }), "gpt-4.1")).toBe("responses");
  });

  /**
   * `baseUrl` is how people point this plugin at Azure, a proxy, or a local
   * gateway. Those speak chat-completions and generally have no /v1/responses,
   * so auto must not route there on their behalf — but an explicit pin still
   * must, since some of them do.
   */
  it("does not auto-route away from api.openai.com", () => {
    const proxied = cfg({ baseUrl: "https://my-gateway.internal/v1" });
    expect(selectApi(proxied, "gpt-5.6-luna")).toBe("chat");
    expect(selectApi({ ...proxied, api: "responses" }, "gpt-5.6-luna")).toBe("responses");
  });

  it("treats a malformed baseUrl as not-OpenAI rather than throwing", () => {
    expect(selectApi(cfg({ baseUrl: "not a url" }), "gpt-5.6-luna")).toBe("chat");
  });
});

describe("validateConfig", () => {
  const wrap = (openai: OpenAIConfig) => ({ providers: { openai } }) as unknown as Parameters<typeof validateConfig>[0];

  it("rejects an api value that is not an endpoint", () => {
    expect(validateConfig(wrap(cfg({ api: "responsez" as never }))).join(" ")).toMatch(/api must be one of/);
  });

  it("says so when auto cannot reach the Responses API", () => {
    // Config that parses and is then quietly ignored is the recurring bug in
    // this repo; auto + a non-OpenAI baseUrl is exactly that shape.
    const warnings = validateConfig(wrap(cfg({ api: "auto", baseUrl: "https://gateway.internal/v1" })));
    expect(warnings.join(" ")).toMatch(/only routes to \/v1\/responses on api\.openai\.com/);
  });

  it("stays quiet for a normal OpenAI config", () => {
    expect(validateConfig(wrap(cfg({ api: "auto" })))).toEqual([]);
  });
});

describe("OpenAIRouterProvider", () => {
  const stub = (id: string): AIProvider & { seen: string[] } => {
    const seen: string[] = [];
    return {
      id,
      name: id,
      supportsTools: true,
      seen,
      async chat(params: ChatParams): Promise<ChatResponse> {
        seen.push(params.model);
        return { content: id, usage: { input: 0, output: 0 }, finishReason: "stop" };
      },
      async *chatStream() {
        yield {
          type: "done" as const,
          response: { content: id, usage: { input: 0, output: 0 }, finishReason: "stop" as const },
        };
      },
    };
  };

  it("dispatches per call, not per construction", async () => {
    const chat = stub("chat");
    const responses = stub("responses");
    const router = new OpenAIRouterProvider({ chat, responses, select: (m) => selectApi(cfg(), m) });

    // Built with defaultModel gpt-5-mini, then asked for a model that needs the
    // other endpoint — the case a build-time decision would get wrong.
    expect((await router.chat({ model: "gpt-5-mini", messages: [] })).content).toBe("chat");
    expect((await router.chat({ model: "gpt-5.6-luna", messages: [] })).content).toBe("responses");

    expect(chat.seen).toEqual(["gpt-5-mini"]);
    expect(responses.seen).toEqual(["gpt-5.6-luna"]);
  });

  it("routes streaming the same way", async () => {
    const router = new OpenAIRouterProvider({
      chat: stub("chat"),
      responses: stub("responses"),
      select: (m) => selectApi(cfg(), m),
    });

    const out = [];
    for await (const ev of router.chatStream({ model: "gpt-5.6-luna", messages: [] })) out.push(ev);
    expect(out[0]).toMatchObject({ response: { content: "responses" } });
  });
});
