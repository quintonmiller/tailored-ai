/**
 * Two places where context is removed, and the model was told neither.
 *
 * A conversation trimmed to fit the budget simply began later, so the model
 * could not tell "this is where we started" from "the start was evicted" — and
 * answered as though the former. A room that outran its backlog window was
 * handed the newest page under the heading "New messages:", as though nothing
 * had been skipped.
 *
 * Both mechanisms already existed to say so; neither was wired to the default
 * path.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markDroppedHistory, runAgentLoop } from "../agent/loop.js";
import { newSession } from "../agent/session.js";
import { saveMessage } from "../db/queries.js";
import { initDatabase } from "../db/schema.js";
import type { AIProvider, ChatParams, ChatResponse, Message } from "../providers/interface.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

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

describe("markDroppedHistory", () => {
  const history: Message[] = [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" },
  ];

  it("says nothing when nothing was dropped", () => {
    expect(markDroppedHistory(history, history)).toEqual(history);
  });

  it("leads with a count of what is missing", () => {
    const out = markDroppedHistory(history, history.slice(2));
    expect(out).toHaveLength(2);
    expect(out[0].content).toContain("2 earlier messages");
    expect(out[0].content).toContain("no longer shown");
  });

  it("gets the singular right, because one message is the common case", () => {
    const out = markDroppedHistory(history, history.slice(1));
    expect(out[0].content).toContain("1 earlier message in this");
  });

  it("states a fact and gives no instruction", () => {
    const out = markDroppedHistory(history, history.slice(2));
    // An instruction to "ask if you need anything earlier" is the shape that
    // gets taken far more often than intended — an agent opening every turn by
    // asking about its own trimmed history is worse than one that cannot.
    expect(out[0].content).not.toMatch(/\bask\b/i);
    expect(out[0].content).not.toMatch(/\byou (should|can|may)\b/i);
  });

  it("keeps the surviving conversation in order behind it", () => {
    const out = markDroppedHistory(history, history.slice(1));
    expect(out.slice(1)).toEqual(history.slice(1));
  });
});

describe("a trimmed conversation says it was trimmed", () => {
  it("tells the model the history does not start where it appears to", async () => {
    const session = newSession(db, "fake-model", "fake");
    for (let i = 0; i < 40; i++) {
      saveMessage(db, session.id, { role: "user", content: `message ${i} ${"z".repeat(400)}` });
      saveMessage(db, session.id, { role: "assistant", content: `reply ${i}` });
    }
    const seen: ChatParams[] = [];

    await runAgentLoop("go", {
      provider: recordingProvider(seen),
      session,
      db,
      tools: [],
      extraInstructions: "",
      maxToolRounds: 2,
      maxHistoryTokens: 2000,
      temperature: 0.3,
    });

    const first = seen[0].messages.find((m) => m.role !== "system");
    expect(first?.content).toContain("no longer shown");
  });

  it("stays quiet when the whole conversation fits", async () => {
    const session = newSession(db, "fake-model", "fake");
    saveMessage(db, session.id, { role: "user", content: "short" });
    const seen: ChatParams[] = [];

    await runAgentLoop("go", {
      provider: recordingProvider(seen),
      session,
      db,
      tools: [],
      extraInstructions: "",
      maxToolRounds: 2,
      maxHistoryTokens: 50_000,
      temperature: 0.3,
    });

    expect(seen[0].messages.some((m) => m.content?.includes("no longer shown"))).toBe(false);
  });

  it("stays inside the budget it was trimmed to fit", async () => {
    const session = newSession(db, "fake-model", "fake");
    for (let i = 0; i < 40; i++) {
      saveMessage(db, session.id, { role: "user", content: `message ${i} ${"z".repeat(400)}` });
    }
    const seen: ChatParams[] = [];

    await runAgentLoop("go", {
      provider: recordingProvider(seen),
      session,
      db,
      tools: [],
      extraInstructions: "",
      maxToolRounds: 2,
      maxHistoryTokens: 2000,
      temperature: 0.3,
    });

    // The marker is reserved for before trimming, not bolted on after — which
    // would push the request back over the budget it had just been cut to fit.
    const chars = seen[0].messages.reduce((n, m) => n + (m.content ?? "").length, 0);
    expect(Math.ceil(chars / 4)).toBeLessThanOrEqual(2000);
  });
});
