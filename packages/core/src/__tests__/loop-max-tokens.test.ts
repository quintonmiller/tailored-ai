/**
 * `maxTokens` has to reach the provider on the loop's own chat calls, not just
 * exist on the type.
 *
 * `ChatParams.maxTokens` and `OpenAIProvider`'s `max_tokens` mapping were both
 * already present; nothing populated them, so every agent request went out with
 * the field absent. That is fine locally and expensive on a metered provider —
 * OpenRouter reserves the model's full output window (65536) against the
 * balance for the duration of a call when `max_tokens` is missing, and returns
 * 402 once the balance no longer covers the reservation, however small the
 * actual reply would have been.
 *
 * The omission case matters as much as the pass-through: defaulting to a number
 * we invented would silently cap generation everywhere.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../agent/loop.js";
import { newSession } from "../agent/session.js";
import { initDatabase } from "../db/schema.js";
import type { AIProvider, ChatParams, ChatResponse } from "../providers/interface.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

/** Captures what the loop actually handed the provider. */
function recordingProvider(seen: ChatParams[]): AIProvider {
  return {
    id: "fake",
    name: "fake",
    supportsTools: true,
    async chat(params: ChatParams): Promise<ChatResponse> {
      seen.push(params);
      return { content: "ok", usage: { input: 0, output: 0 }, finishReason: "stop" };
    },
  };
}

function run(seen: ChatParams[], over: Record<string, unknown> = {}) {
  return runAgentLoop("go", {
    provider: recordingProvider(seen),
    session: newSession(db, "fake-model", "fake"),
    db,
    tools: [],
    extraInstructions: "",
    maxToolRounds: 2,
    maxHistoryTokens: 5000,
    temperature: 0.3,
    ...over,
  });
}

describe("runAgentLoop — maxTokens", () => {
  it("forwards the resolved cap to the provider", async () => {
    const seen: ChatParams[] = [];
    await run(seen, { maxTokens: 4096 });

    expect(seen).toHaveLength(1);
    expect(seen[0].maxTokens).toBe(4096);
  });

  it("omits the field entirely when unset", async () => {
    const seen: ChatParams[] = [];
    await run(seen);

    expect(seen).toHaveLength(1);
    expect(seen[0].maxTokens).toBeUndefined();
  });
});
