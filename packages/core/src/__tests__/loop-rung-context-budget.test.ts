/**
 * `historyBudget` was computed once, from `maxHistoryTokens`, before any
 * request was made — then every rung of the fallback chain was tried against
 * that same budget. A chain whose later rungs have smaller context windows can
 * therefore build a request the head accepts and the fallback cannot.
 *
 * The failure is not silent, but it is expensive and it reads wrong: the rung
 * rejects the request and the chain moves on, and if every remaining rung is
 * smaller than the head the turn fails looking like an outage rather than a
 * budget mistake.
 *
 * `ModelEntry.maxContextTokens` already existed; it was only read by the
 * `/context` display.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chatWithFallback, type ModelCandidate, runAgentLoop } from "../agent/loop.js";
import { newSession } from "../agent/session.js";
import { DEFAULT_LAYER_ORDER } from "../agent/system-prompt.js";
import { saveMessage } from "../db/queries.js";
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

function recorder(seen: ChatParams[], fail = false): AIProvider {
  return {
    id: "p",
    name: "p",
    supportsTools: true,
    async chat(params: ChatParams): Promise<ChatResponse> {
      seen.push(params);
      if (fail) throw new Error("down");
      return { content: "ok", usage: { input: 0, output: 0 }, finishReason: "stop" };
    },
  } as AIProvider;
}

/** ~2000 tokens of history, comfortably over a small rung's window. */
function seedHistory(sessionId: string, count = 30) {
  for (let i = 0; i < count; i++) {
    saveMessage(db, sessionId, { role: "user", content: `msg ${i} ${"filler ".repeat(60)}` });
  }
}

function run(chain: ModelCandidate[], over: Record<string, unknown> = {}) {
  const session = newSession(db, "head-model", "p");
  seedHistory(session.id);
  return runAgentLoop("go", {
    provider: chain[0].provider,
    session,
    db,
    tools: [],
    extraInstructions: "",
    maxToolRounds: 2,
    maxHistoryTokens: 100_000,
    temperature: 0.3,
    getModelChain: () => chain,
    ...over,
  });
}

const historyCount = (p: ChatParams) => p.messages.filter((m) => m.content?.startsWith("msg ")).length;

describe("per-rung history budget", () => {
  it("sizes the request to the rung that gets it, not to the head", async () => {
    const headSeen: ChatParams[] = [];
    const smallSeen: ChatParams[] = [];
    await run([
      { provider: recorder(headSeen, true), model: "big", label: "head", maxContextTokens: 400_000 },
      { provider: recorder(smallSeen), model: "small", label: "fallback", maxContextTokens: 500 },
    ]);

    expect(historyCount(headSeen[0])).toBeGreaterThan(0);
    expect(historyCount(smallSeen[0])).toBeLessThan(historyCount(headSeen[0]));
  });

  it("leaves a roomy rung's request untouched", async () => {
    const headSeen: ChatParams[] = [];
    const otherSeen: ChatParams[] = [];
    await run([
      { provider: recorder(headSeen, true), model: "a", label: "a", maxContextTokens: 400_000 },
      { provider: recorder(otherSeen), model: "b", label: "b", maxContextTokens: 400_000 },
    ]);

    expect(historyCount(otherSeen[0])).toBe(historyCount(headSeen[0]));
    expect(otherSeen[0].messages).toEqual(headSeen[0].messages);
  });

  it("changes nothing for a rung that declares no window", async () => {
    const a: ChatParams[] = [];
    const b: ChatParams[] = [];
    await run([
      { provider: recorder(a, true), model: "a", label: "a" },
      { provider: recorder(b), model: "b", label: "b" },
    ]);
    expect(b[0].messages).toEqual(a[0].messages);
  });

  it("keeps the system prompt on the refitted request", async () => {
    const seen: ChatParams[] = [];
    await run([
      { provider: recorder([], true), model: "a", label: "a", maxContextTokens: 400_000 },
      { provider: recorder(seen), model: "small", label: "small", maxContextTokens: 500 },
    ]);
    expect(seen[0].messages[0].role).toBe("system");
  });

  it("charges the system prompt against the rung's window, not just the history", async () => {
    const seen: ChatParams[] = [];
    // A window barely larger than the prompt leaves almost nothing for history.
    await run(
      [
        { provider: recorder([], true), model: "a", label: "a", maxContextTokens: 400_000 },
        { provider: recorder(seen), model: "tiny", label: "tiny", maxContextTokens: 900 },
      ],
      { extraInstructions: "x".repeat(3200) }, // ~800 tokens of system prompt
    );
    expect(historyCount(seen[0])).toBe(0);
  });

  it("says what it dropped and for whom", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await run([
      { provider: recorder([], true), model: "a", label: "a", maxContextTokens: 400_000 },
      { provider: recorder([]), model: "small", label: "cheap-cloud", maxContextTokens: 500 },
    ]);
    const said = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(said).toContain("cheap-cloud");
    expect(said).toContain("500-token window");
    expect(said).toMatch(/trimming \d+ more message/);
  });

  it("still carries the other per-call params to the refitted rung", async () => {
    const seen: ChatParams[] = [];
    await run(
      [
        { provider: recorder([], true), model: "a", label: "a", maxContextTokens: 400_000 },
        { provider: recorder(seen), model: "small", label: "small", maxContextTokens: 500 },
      ],
      { maxTokens: 4096, thinking: "off" },
    );
    expect(seen[0]).toMatchObject({ maxTokens: 4096, thinking: "off", temperature: 0.3 });
  });
});

describe("the volatile tail survives a refit", () => {
  // Two independent per-rung mechanisms meet here: the tail rides *behind* the
  // history, and a small rung rebuilds the message array to fit its window.
  // Rebuilding from the system prompt alone drops the live state and recall the
  // model is meant to read this turn — a hole neither change could see alone.
  const volatileLayer = {
    order: [...DEFAULT_LAYER_ORDER, "vol"],
    tail: ["vol"],
    custom: [{ name: "vol", content: "VOLATILE-BLOCK" }],
  };

  it("keeps the tail on a rung whose history was re-trimmed", async () => {
    const seen: ChatParams[] = [];
    await run(
      [
        { provider: recorder([], true), model: "big", label: "head", maxContextTokens: 400_000 },
        { provider: recorder(seen), model: "small", label: "small", maxContextTokens: 600 },
      ],
      { systemPrompt: volatileLayer },
    );

    const msgs = seen[0].messages;
    expect(msgs[msgs.length - 1].content).toContain("VOLATILE-BLOCK");
    expect(msgs.filter((m) => m.content?.includes("VOLATILE-BLOCK"))).toHaveLength(1);
    // Really did take the refit branch, so this is not passing by skipping it.
    expect(historyCount(seen[0])).toBeLessThan(30);
  });

  it("reserves the tail's tokens against the rung's window", async () => {
    const withTail: ChatParams[] = [];
    const withoutTail: ChatParams[] = [];
    const chain = (seen: ChatParams[]): ModelCandidate[] => [
      { provider: recorder([], true), model: "big", label: "head", maxContextTokens: 400_000 },
      { provider: recorder(seen), model: "small", label: "small", maxContextTokens: 4000 },
    ];
    const big = { ...volatileLayer, custom: [{ name: "vol", content: "x".repeat(8000) }] };
    await run(chain(withTail), { systemPrompt: big });
    await run(chain(withoutTail), { systemPrompt: { ...big, tail: [] } });

    // Same content either way; the rung's window has to cover it wherever it sits.
    expect(historyCount(withTail[0])).toBeLessThanOrEqual(historyCount(withoutTail[0]));
  });
});

describe("chatWithFallback — params as a function", () => {
  it("accepts a plain object exactly as before", async () => {
    const seen: ChatParams[] = [];
    const out = await chatWithFallback([{ provider: recorder(seen), model: "m", label: "l" }], {
      messages: [{ role: "user", content: "hi" }],
      temperature: 0.3,
    });
    expect(out.response.content).toBe("ok");
    expect(seen[0].messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("calls the builder once per rung, with that rung", async () => {
    const asked: string[] = [];
    const a = recorder([], true);
    const b = recorder([]);
    await chatWithFallback(
      [
        { provider: a, model: "a", label: "a" },
        { provider: b, model: "b", label: "b" },
      ],
      (c) => {
        asked.push(c.label);
        return { messages: [{ role: "user", content: c.label }], temperature: 0.3 };
      },
    );
    expect(asked).toEqual(["a", "b"]);
  });
});
