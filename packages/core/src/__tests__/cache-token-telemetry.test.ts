/**
 * Whether a prompt-cache change can be measured at all.
 *
 * `ChatResponse.usage` carried `{ input, output }`, and the Anthropic provider
 * sums cache reads and writes *into* `input` — so a perfect cache hit and a
 * completely cold read recorded identical numbers. Prompt-cache behaviour is
 * the main reason to care about request layout, and there was no signal for it
 * anywhere: not in the DB, not on `/api/usage`.
 *
 * The distinction these pin is between "nothing was cached" and "this provider
 * does not report caching". They are different facts and must not both be zero.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../agent/loop.js";
import { newSession } from "../agent/session.js";
import { initDatabase } from "../db/schema.js";
import type { AIProvider, ChatParams, ChatResponse, TokenUsage } from "../providers/interface.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

function providerReporting(usage: TokenUsage): AIProvider {
  return {
    id: "fake",
    name: "fake",
    supportsTools: true,
    async chat(_params: ChatParams): Promise<ChatResponse> {
      return { content: "ok", usage, finishReason: "stop" };
    },
  };
}

async function runWith(
  usage: TokenUsage,
): Promise<{ cache_read_tokens: number | null; cache_write_tokens: number | null }> {
  await runAgentLoop("go", {
    provider: providerReporting(usage),
    session: newSession(db, "fake-model", "fake"),
    db,
    tools: [],
    extraInstructions: "",
    maxToolRounds: 2,
    maxHistoryTokens: 5000,
    temperature: 0.3,
  });
  return db.prepare("SELECT cache_read_tokens, cache_write_tokens FROM token_usage ORDER BY id DESC LIMIT 1").get() as {
    cache_read_tokens: number | null;
    cache_write_tokens: number | null;
  };
}

describe("cache tokens reach the database", () => {
  it("records what a reporting provider says", async () => {
    const row = await runWith({ input: 1000, output: 50, cacheRead: 800, cacheWrite: 120 });
    expect(row.cache_read_tokens).toBe(800);
    expect(row.cache_write_tokens).toBe(120);
  });

  it("stores NULL — not 0 — when the provider does not report caching", async () => {
    const row = await runWith({ input: 1000, output: 50 });
    // A zero here would read as "the cache did nothing" rather than "nobody
    // said", and most providers never say.
    expect(row.cache_read_tokens).toBeNull();
    expect(row.cache_write_tokens).toBeNull();
  });

  it("keeps a reported zero distinct from silence", async () => {
    const row = await runWith({ input: 1000, output: 50, cacheRead: 0, cacheWrite: 0 });
    // A provider that reports caching and saw none is a real, useful signal:
    // it means the prefix missed, which is exactly what a layout change fixes.
    expect(row.cache_read_tokens).toBe(0);
    expect(row.cache_write_tokens).toBe(0);
  });

  it("tells a cache hit apart from a cold read", async () => {
    const cold = await runWith({ input: 1000, output: 50, cacheRead: 0, cacheWrite: 1000 });
    const warm = await runWith({ input: 1000, output: 50, cacheRead: 1000, cacheWrite: 0 });

    // The whole point. Before this both rows recorded prompt_tokens: 1000 and
    // were indistinguishable.
    expect(cold.cache_read_tokens).toBe(0);
    expect(warm.cache_read_tokens).toBe(1000);
  });

  it("still records the row when caching is absent", async () => {
    await runWith({ input: 42, output: 7 });
    const row = db
      .prepare("SELECT prompt_tokens, completion_tokens FROM token_usage ORDER BY id DESC LIMIT 1")
      .get() as {
      prompt_tokens: number;
      completion_tokens: number;
    };
    expect(row).toEqual({ prompt_tokens: 42, completion_tokens: 7 });
  });
});
