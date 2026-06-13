import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleEmbeddingProvider } from "../providers/openai-embedding.js";

function okResponse(count: number) {
  return {
    ok: true,
    json: async () => ({
      data: Array.from({ length: count }, (_, i) => ({ index: i, embedding: [0.1, 0.2, 0.3] })),
      model: "test-embed",
      usage: { prompt_tokens: 1, total_tokens: 1 },
    }),
  };
}

function overflow400() {
  return {
    ok: false,
    status: 400,
    text: async () => '{"error":{"message":"the input length exceeds the context length"}}',
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("OpenAICompatibleEmbeddingProvider input clamping", () => {
  it("truncates inputs longer than maxInputChars before sending", async () => {
    const fetchMock = vi.fn(async () => okResponse(1) as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAICompatibleEmbeddingProvider({
      baseUrl: "http://localhost:1234/v1",
      defaultModel: "test-embed",
      maxInputChars: 100,
    });
    await provider.embed(["x".repeat(5000)]);

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.input[0].length).toBe(100);
  });

  it("retries with a halved clamp on a context-overflow 400, then succeeds", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      // First attempt overflows; second succeeds.
      return (call === 1 ? overflow400() : okResponse(1)) as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAICompatibleEmbeddingProvider({
      baseUrl: "http://localhost:1234/v1",
      defaultModel: "test-embed",
      maxInputChars: 8000,
    });
    const result = await provider.embed(["y".repeat(20000)]);

    expect(result.vectors).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstLen = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string).input[0].length;
    const secondLen = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string).input[0].length;
    expect(firstLen).toBe(8000);
    expect(secondLen).toBe(4000); // halved
  });
});
