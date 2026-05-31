import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../tools/interface.js";
import { CheckActionStatusTool, PurchaseItemTool, RequestActionTool } from "../tools/request-action.js";

const ctx: ToolContext = {
  sessionId: "test-session",
  workingDirectory: process.cwd(),
  env: {},
};

function mockFetch(responses: Array<{ status: number; body: unknown }>): typeof fetch {
  let i = 0;
  return (async () => {
    const r = responses[i++] ?? responses[responses.length - 1];
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

describe("RequestActionTool", () => {
  it("rejects calls missing type/input", async () => {
    const tool = new RequestActionTool({
      url: "http://x",
      sharedSecret: "s",
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    expect((await tool.execute({}, ctx)).success).toBe(false);
    expect((await tool.execute({ type: "x" }, ctx)).success).toBe(false);
  });

  it("posts to /internal/enqueue with the shared secret + body", async () => {
    const captured: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      captured.push({ url, init });
      return new Response(JSON.stringify({ action_id: "ta_abc", status: "pending_approval" }), {
        status: 202,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const tool = new RequestActionTool({ url: "http://localhost:3100", sharedSecret: "shh", fetchImpl });
    const res = await tool.execute({ type: "purchase.amazon", input: { max_price: 10 }, why: "test" }, ctx);
    expect(res.success).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("http://localhost:3100/internal/enqueue");
    const headers = (captured[0].init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer shh");
    const body = JSON.parse(captured[0].init?.body as string) as Record<string, unknown>;
    expect(body.type).toBe("purchase.amazon");
    expect((body.input as Record<string, unknown>).why).toBe("test");
  });

  it("surfaces executor errors with a clear message", async () => {
    const fetchImpl = mockFetch([{ status: 402, body: { error: "Per-request cap exceeded: $100 > $50" } }]);
    const tool = new RequestActionTool({ url: "http://x", sharedSecret: "s", fetchImpl });
    const res = await tool.execute({ type: "purchase.amazon", input: {} }, ctx);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/cap exceeded/);
  });

  it("handles executor unreachable", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const tool = new RequestActionTool({ url: "http://x", sharedSecret: "s", fetchImpl });
    const res = await tool.execute({ type: "x", input: {} }, ctx);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Executor unreachable/);
  });
});

describe("PurchaseItemTool", () => {
  const fetchImpl = mockFetch([{ status: 202, body: { action_id: "ta_buy", status: "pending_approval" } }]);
  const tool = new PurchaseItemTool({ url: "http://x", sharedSecret: "s", fetchImpl });

  it("requires url OR query", async () => {
    const res = await tool.execute({ max_price: 10, why: "needed" }, ctx);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/url.*query/);
  });

  it("requires positive max_price", async () => {
    expect((await tool.execute({ query: "x", max_price: 0, why: "needed" }, ctx)).success).toBe(false);
    expect((await tool.execute({ query: "x", max_price: -1, why: "needed" }, ctx)).success).toBe(false);
    expect((await tool.execute({ query: "x", max_price: "10" as unknown as number, why: "needed" }, ctx)).success).toBe(
      false,
    );
  });

  it("requires why (>= 5 chars)", async () => {
    expect((await tool.execute({ query: "x", max_price: 5, why: "" }, ctx)).success).toBe(false);
    expect((await tool.execute({ query: "x", max_price: 5, why: "ab" }, ctx)).success).toBe(false);
  });

  it("rejects qty outside 1-10", async () => {
    expect((await tool.execute({ query: "x", max_price: 5, why: "test why", qty: 0 }, ctx)).success).toBe(false);
    expect((await tool.execute({ query: "x", max_price: 5, why: "test why", qty: 11 }, ctx)).success).toBe(false);
  });

  it("enqueues valid request", async () => {
    const res = await tool.execute({ query: "coffee filter", max_price: 12, why: "kitchen refill" }, ctx);
    expect(res.success).toBe(true);
    expect(res.output).toContain("ta_buy");
  });
});

describe("CheckActionStatusTool", () => {
  it("rejects empty action_id", async () => {
    const tool = new CheckActionStatusTool({
      url: "http://x",
      sharedSecret: "s",
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    const res = await tool.execute({}, ctx);
    expect(res.success).toBe(false);
  });

  it("returns the executor's status body on success", async () => {
    const fetchImpl = mockFetch([
      { status: 200, body: { id: "ta_x", status: "completed", result: { order_id: "111-222" } } },
    ]);
    const tool = new CheckActionStatusTool({ url: "http://x", sharedSecret: "s", fetchImpl });
    const res = await tool.execute({ action_id: "ta_x" }, ctx);
    expect(res.success).toBe(true);
    expect(res.output).toContain("completed");
    expect(res.output).toContain("111-222");
  });

  it("404 → 'not found' error", async () => {
    const fetchImpl = mockFetch([{ status: 404, body: { error: "Action not found" } }]);
    const tool = new CheckActionStatusTool({ url: "http://x", sharedSecret: "s", fetchImpl });
    const res = await tool.execute({ action_id: "missing" }, ctx);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/not found/);
  });
});
