import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleSpeech } from "../providers/openai-compatible.js";

/**
 * These test the request body, which is the half that goes wrong quietly.
 *
 * A delivery direction that reaches the tool, survives parsing, and is dropped
 * on the way onto the wire produces audio — correct words, flat reading — and
 * nothing but listening reveals it. That failure has shipped here four times
 * in other subsystems under the name "declared but never wired".
 */
function stubFetch(): { body: () => Record<string, unknown> } {
  let seen: Record<string, unknown> = {};
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    seen = JSON.parse(String(init.body));
    return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/wav" } });
  });
  return { body: () => seen };
}

afterEach(() => vi.unstubAllGlobals());

describe("OpenAICompatibleSpeech request body", () => {
  it("sends a direction as `instructions`", async () => {
    const seen = stubFetch();
    const p = new OpenAICompatibleSpeech({ baseUrl: "http://x/v1", model: "m", voice: "v" });
    await p.synthesize({
      utterances: [{ text: "Give me the ledger.", direction: "flat, a count not a threat" }],
      format: "wav",
    });
    expect(seen.body().instructions).toBe("flat, a count not a threat");
    expect(seen.body().input).toBe("Give me the ledger.");
  });

  it("omits the field entirely when there is no direction", async () => {
    const seen = stubFetch();
    const p = new OpenAICompatibleSpeech({ baseUrl: "http://x/v1", model: "m", voice: "v" });
    await p.synthesize({ utterances: [{ text: "Plain line." }], format: "wav" });
    expect("instructions" in seen.body()).toBe(false);
  });
});
