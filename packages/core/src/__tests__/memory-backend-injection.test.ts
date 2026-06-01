/**
 * Phase 2 acceptance test: a third-party memory backend, when wired
 * through `AgentLoopOptions.getMemoryBackend`, actually gets exercised
 * by the agent loop's memory-injection path. No SQL is hit.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentLoopOptions, runAgentLoop } from "../agent/loop.js";
import { newSession } from "../agent/session.js";
import { initDatabase } from "../db/schema.js";
import type { MemoryBackend, MemoryFragment } from "../memory/interface.js";
import type { AIProvider, Message } from "../providers/interface.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

interface MockProvider extends AIProvider {
  calls: Array<{ system: string; messages: Message[] }>;
}

function makeProvider(): MockProvider {
  const calls: MockProvider["calls"] = [];
  return {
    id: "mock",
    name: "mock",
    supportsTools: true,
    calls,
    chat: async (params) => {
      const messages = params.messages;
      const sys = (messages.find((m) => m.role === "system")?.content ?? "") as string;
      calls.push({
        system: sys,
        messages: messages.filter((m) => m.role !== "system"),
      });
      return { content: "ok", usage: { input: 0, output: 0 }, finishReason: "stop" };
    },
  } as MockProvider;
}

function baseOpts(provider: AIProvider): Omit<AgentLoopOptions, "provider" | "session"> {
  return {
    db,
    tools: [],
    extraInstructions: "",
    maxToolRounds: 1,
    maxHistoryTokens: 2000,
    temperature: 0.3,
  };
}

describe("Phase 2: custom memory backend exercised through the loop", () => {
  it("buildMemoryBlock calls the plugin backend's query method, not SQL", async () => {
    const calls: { freeText?: string; includePrelude?: boolean }[] = [];
    const fragments: MemoryFragment[] = [
      {
        text: "plugin-backed observation about widget Q",
        id: "plugin:1",
        metadata: { kind: "note", score: 0.9, snippet: "plugin-backed observation about widget Q" },
      },
    ];
    const fakeBackend: MemoryBackend = {
      id: "fake",
      write: async () => ({ id: "x" }),
      query: async (ctx) => {
        calls.push({ freeText: ctx.freeText, includePrelude: ctx.includePrelude });
        // Pinned tier call uses includePrelude with no freeText; relevance
        // tier uses freeText. Only return fragments for the relevance call
        // so we can prove both paths route here.
        return ctx.freeText ? fragments : [];
      },
    };

    const session = newSession(db, "fake-model", "fake", undefined, null);
    const provider = makeProvider();

    await runAgentLoop("widget Q", {
      ...baseOpts(provider),
      provider,
      session,
      injectMemory: true,
      getMemoryBackend: async () => fakeBackend,
    });

    // Both tiers fan out to the backend. SQLite is never queried.
    expect(calls.length).toBe(2);
    expect(calls.some((c) => c.includePrelude === true)).toBe(true);
    expect(calls.some((c) => c.freeText === "widget Q")).toBe(true);

    const sys = provider.calls[0].system;
    expect(sys).toContain("[Relevant memory]");
    expect(sys).toContain("plugin-backed observation about widget Q");
  });

  it("no memory injection when getMemoryBackend is absent, even with injectMemory=true", async () => {
    const session = newSession(db, "fake-model", "fake", undefined, null);
    const provider = makeProvider();
    await runAgentLoop("anything", {
      ...baseOpts(provider),
      provider,
      session,
      injectMemory: true,
      // getMemoryBackend intentionally absent
    });
    expect(provider.calls[0].system).not.toContain("[Relevant memory]");
  });
});
