/**
 * Shared vitest suite that any {@link AIProvider} implementation can plug
 * into to prove it satisfies the contract — the provider sibling of
 * `runChannelContractSuite`. A provider plugin (Bedrock, Cohere, …) gets its
 * contract coverage in ~10 LOC: stub the transport, hand `build` to the
 * suite.
 *
 * What it asserts:
 *   - `chat()` returns a structurally valid {@link ChatResponse}
 *   - `chat()` tolerates the message shapes the agent loop produces
 *     (leading system, mid-conversation system, assistant tool calls,
 *     tool results, empty content)
 *   - `chat()` accepts a `tools` parameter
 *   - when `chatStream` is implemented: every event is delta or done,
 *     exactly one done arrives last, and concatenated delta text equals
 *     `done.response.content` (#227)
 *   - when `listModels` is implemented: it resolves to string ids
 *
 * Transport details (fetch mocks, SDK client stubs) stay inside the
 * provider package's test setup — the suite never touches the network.
 */

import { describe, expect, it } from "vitest";
import type { AIProvider, ChatParams, ChatResponse, ToolSchema } from "../providers/interface.js";

/**
 * Structural view of the streaming events (#227). Declared locally so the
 * suite validates the shape itself rather than trusting the compiler —
 * a plugin compiled against older core types still gets checked.
 */
type StreamEventShape = { type: "delta"; content: string } | { type: "done"; response: ChatResponse };

const SAMPLE_TOOLS: ToolSchema[] = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string", description: "City name" } },
        required: ["city"],
      },
    },
  },
];

/** The mixed history every provider must accept without throwing. */
const MIXED_HISTORY: ChatParams["messages"] = [
  { role: "system", content: "You are a contract test." },
  { role: "system", content: "Be terse." },
  { role: "user", content: "What's the weather in Oslo?" },
  {
    role: "assistant",
    content: "Checking.",
    toolCalls: [{ id: "tc_1", name: "get_weather", arguments: { city: "Oslo" } }],
  },
  { role: "tool", content: "12C, raining", toolCallId: "tc_1" },
  { role: "assistant", content: null },
  { role: "system", content: "Config reloaded." },
  { role: "user", content: "And tomorrow?" },
];

/**
 * Assert a {@link ChatResponse} is structurally valid. Exported so provider
 * packages can reuse it in bespoke tests outside the suite.
 */
export function assertValidChatResponse(response: ChatResponse): void {
  expect(response.content === null || typeof response.content === "string").toBe(true);
  expect(typeof response.usage?.input).toBe("number");
  expect(typeof response.usage?.output).toBe("number");
  expect(response.usage.input).toBeGreaterThanOrEqual(0);
  expect(response.usage.output).toBeGreaterThanOrEqual(0);
  expect(["stop", "tool_calls", "length"]).toContain(response.finishReason);
  if (response.toolCalls !== undefined) {
    expect(Array.isArray(response.toolCalls)).toBe(true);
    for (const tc of response.toolCalls) {
      expect(typeof tc.id).toBe("string");
      expect(typeof tc.name).toBe("string");
      expect(tc.name.length).toBeGreaterThan(0);
      expect(tc.arguments).toBeTypeOf("object");
      expect(tc.arguments).not.toBeNull();
    }
  }
}

export interface ProviderContractHarness {
  /**
   * Build a fresh provider wired to a stubbed transport. Called once per
   * test so state never leaks. The stub must answer `chat()` with any
   * well-formed completion; when the provider implements `chatStream`,
   * the stub must answer streaming requests too.
   */
  build(): AIProvider | Promise<AIProvider>;
  /**
   * Overrides merged into every `ChatParams` the suite sends (e.g. a
   * model id your stub keys on). `messages` is owned by the suite.
   */
  params?: Partial<Omit<ChatParams, "messages">>;
}

export interface ProviderContractOptions {
  /** Provider id under test — used in describe(). */
  name: string;
  harness: ProviderContractHarness;
}

/**
 * Drive an {@link AIProvider} implementation through the contract suite.
 * Call from a vitest test file — the helper invokes `describe`/`it`/`expect`
 * directly.
 *
 *     import { runProviderContractSuite } from "@tailored-ai/core/testing";
 *
 *     runProviderContractSuite({
 *       name: "bedrock",
 *       harness: {
 *         build: () => new BedrockProvider({ client: stubClient() }),
 *         params: { model: "us.amazon.nova-micro-v1:0" },
 *       },
 *     });
 */
export function runProviderContractSuite(opts: ProviderContractOptions): void {
  const { name, harness } = opts;

  const baseParams = (messages: ChatParams["messages"]): ChatParams => ({
    model: "contract-test-model",
    ...harness.params,
    messages,
  });

  describe(`Provider contract: ${name}`, () => {
    it("exposes id, name, and supportsTools", async () => {
      const provider = await harness.build();
      expect(typeof provider.id).toBe("string");
      expect(provider.id.length).toBeGreaterThan(0);
      expect(typeof provider.name).toBe("string");
      expect(typeof provider.supportsTools).toBe("boolean");
    });

    it("chat() returns a structurally valid ChatResponse", async () => {
      const provider = await harness.build();
      const response = await provider.chat(baseParams([{ role: "user", content: "Hello" }]));
      assertValidChatResponse(response);
    });

    it("chat() accepts the mixed history the agent loop produces", async () => {
      const provider = await harness.build();
      const response = await provider.chat(baseParams(MIXED_HISTORY));
      assertValidChatResponse(response);
    });

    it("chat() accepts a tools parameter", async () => {
      const provider = await harness.build();
      const response = await provider.chat({
        ...baseParams([{ role: "user", content: "Weather in Oslo?" }]),
        tools: SAMPLE_TOOLS,
      });
      assertValidChatResponse(response);
    });

    it("chatStream() yields deltas then exactly one done, last (when implemented)", async () => {
      const provider = await harness.build();
      if (!provider.chatStream) return; // optional capability — nothing to assert

      const events: StreamEventShape[] = [];
      for await (const ev of provider.chatStream(baseParams([{ role: "user", content: "Hello" }]))) {
        events.push(ev as unknown as StreamEventShape);
      }

      expect(events.length).toBeGreaterThan(0);
      const dones = events.filter((e) => e.type === "done");
      expect(dones).toHaveLength(1);
      expect(events[events.length - 1].type).toBe("done");

      const done = dones[0] as Extract<StreamEventShape, { type: "done" }>;
      assertValidChatResponse(done.response);

      const deltas = events.filter((e): e is Extract<StreamEventShape, { type: "delta" }> => e.type === "delta");
      for (const d of deltas) {
        expect(typeof d.content).toBe("string");
      }
      const concat = deltas.map((d) => d.content).join("");
      expect(concat).toBe(done.response.content ?? "");
    });

    it("listModels() resolves to model id strings (when implemented)", async () => {
      const provider = await harness.build();
      if (!provider.listModels) return; // optional capability — nothing to assert

      const models = await provider.listModels();
      expect(Array.isArray(models)).toBe(true);
      for (const id of models) {
        expect(typeof id).toBe("string");
        expect(id.length).toBeGreaterThan(0);
      }
    });
  });
}
