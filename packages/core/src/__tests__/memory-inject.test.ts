import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentLoopOptions, runAgentLoop } from "../agent/loop.js";
import { buildMemoryBlock } from "../agent/memory-inject.js";
import { newSession } from "../agent/session.js";
import { upsertFact } from "../db/fact-queries.js";
import { createNote } from "../db/note-queries.js";
import { initDatabase } from "../db/schema.js";
import { SqliteMemoryBackend } from "../memory/sqlite-backend.js";
import type { AIProvider, Message } from "../providers/interface.js";
import type { Tool, ToolContext } from "../tools/interface.js";

let db: Database.Database;
let backend: SqliteMemoryBackend;

beforeEach(() => {
  db = initDatabase(":memory:");
  backend = new SqliteMemoryBackend(db);
});

afterEach(() => {
  db.close();
});

describe("buildMemoryBlock", () => {
  it("returns empty string when no hits", async () => {
    expect(await buildMemoryBlock(backend, { userMessage: "nothing matches", projectId: "p" })).toBe("");
  });

  it("renders a fenced block with tier badge + source + snippet", async () => {
    createNote(db, { content: "watcher saw local llm news", project_id: "p" });
    upsertFact(db, {
      category: "person",
      entity: "alice",
      key: "birthday",
      value: "1988-03-12",
      project_id: "p",
    });
    const block = await buildMemoryBlock(backend, {
      userMessage: "tell me about local llm",
      projectId: "p",
    });
    expect(block).toContain("[Relevant memory]");
    expect(block).toContain("[/Relevant memory]");
    expect(block).toContain("(short)");
    expect(block).toContain("watcher saw local llm news");
  });

  it("scopes by projectId", async () => {
    createNote(db, { content: "alpha bravo", project_id: "p" });
    createNote(db, { content: "alpha bravo", project_id: "q" });
    const block = await buildMemoryBlock(backend, { userMessage: "alpha", projectId: "q" });
    // Only one hit, not two — we don't leak cross-project notes.
    expect((block.match(/\(short\)/g) ?? []).length).toBe(1);
  });

  it("caps output by budgetTokens and reports hidden count", async () => {
    for (let i = 0; i < 8; i++) {
      createNote(db, {
        content: `widget number ${i} blah blah blah filler filler filler filler filler`,
        project_id: "p",
      });
    }
    const block = await buildMemoryBlock(backend, {
      userMessage: "widget",
      projectId: "p",
      limit: 8,
      budgetTokens: 30, // ~120 chars
    });
    expect(block).toContain("more hidden");
  });

  it("always includes the top hit even when budget is tiny", async () => {
    createNote(db, {
      content: "a".repeat(500),
      project_id: "p",
      tags: ["target"],
    });
    const block = await buildMemoryBlock(backend, {
      userMessage: "target",
      projectId: "p",
      budgetTokens: 1,
    });
    expect(block).toContain("[Relevant memory]");
    expect(block).toContain("(short)");
  });
});

// ---------------------------------------------------------------------------
// Integration tests against the real runAgentLoop with a capturing fake provider.
// ---------------------------------------------------------------------------

interface CapturingProvider extends AIProvider {
  calls: Array<{ system: string; history: Message[] }>;
}

function makeProvider(scriptedReplies: Array<{ content: string }>): CapturingProvider {
  const calls: Array<{ system: string; history: Message[] }> = [];
  let i = 0;
  return {
    id: "fake",
    name: "fake",
    supportsTools: true,
    calls,
    chat: async (params) => {
      const messages = params.messages;
      const system = messages.find((m) => m.role === "system")?.content ?? "";
      calls.push({ system, history: messages });
      const reply = scriptedReplies[Math.min(i, scriptedReplies.length - 1)];
      i++;
      return {
        content: reply.content,
        usage: { input: 0, output: 0 },
        finishReason: "stop",
      };
    },
  } as CapturingProvider;
}

function baseOpts(_provider: AIProvider): Omit<AgentLoopOptions, "provider" | "session"> {
  return {
    db,
    tools: [],
    extraInstructions: "",
    maxToolRounds: 1,
    maxHistoryTokens: 2000,
    temperature: 0.3,
    getMemoryBackend: async () => backend,
  };
}

describe("runAgentLoop memory injection (M3)", () => {
  it("does NOT inject memory by default — opt-in only", async () => {
    createNote(db, { content: "this matches the user message", project_id: "p" });
    const session = newSession(db, "fake-model", "fake", undefined, "p");
    const provider = makeProvider([{ content: "ok" }]);

    await runAgentLoop("this matches the user message", {
      ...baseOpts(provider),
      provider,
      session,
    });

    expect(provider.calls[0].system).not.toContain("[Relevant memory]");
  });

  it("injects relevant notes into the system prompt when injectMemory is true", async () => {
    createNote(db, { content: "previously: server uses port 8080", project_id: "p" });
    createNote(db, { content: "unrelated note about cookies", project_id: "p" });
    const session = newSession(db, "fake-model", "fake", undefined, "p");
    const provider = makeProvider([{ content: "ok" }]);

    await runAgentLoop("what port does the server use", {
      ...baseOpts(provider),
      provider,
      session,
      injectMemory: true,
    });

    const sys = provider.calls[0].system;
    expect(sys).toContain("[Relevant memory]");
    expect(sys).toContain("server uses port 8080");
    expect(sys).not.toContain("cookies");
  });

  it("respects the session's projectId for scope", async () => {
    createNote(db, { content: "p-only marker", project_id: "p" });
    createNote(db, { content: "q-only marker", project_id: "q" });
    const sessionP = newSession(db, "fake-model", "fake", undefined, "p");
    const provider = makeProvider([{ content: "ok" }]);

    await runAgentLoop("marker", {
      ...baseOpts(provider),
      provider,
      session: sessionP,
      injectMemory: true,
    });

    expect(provider.calls[0].system).toContain("p-only marker");
    expect(provider.calls[0].system).not.toContain("q-only marker");
  });

  it("emits no block when there are no relevant hits", async () => {
    createNote(db, { content: "unrelated", project_id: "p" });
    const session = newSession(db, "fake-model", "fake", undefined, "p");
    const provider = makeProvider([{ content: "ok" }]);

    await runAgentLoop("entirely different topic", {
      ...baseOpts(provider),
      provider,
      session,
      injectMemory: true,
    });

    expect(provider.calls[0].system).not.toContain("[Relevant memory]");
  });
});

describe("runAgentLoop workingMemory + projectId on ToolContext", () => {
  it("passes a workingMemory Map and projectId on ToolContext", async () => {
    let captured: ToolContext | undefined;

    const probe: Tool = {
      name: "probe",
      description: "captures the tool context",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async (_args, context) => {
        captured = context;
        return { success: true, output: "ok" };
      },
    };

    const session = newSession(db, "fake-model", "fake", undefined, "proj_42");
    const provider: AIProvider = {
      id: "fake",
      name: "fake",
      supportsTools: true,
      chat: vi_chat([
        // round 1: call probe
        {
          content: "",
          toolCalls: [{ id: "tc1", name: "probe", arguments: {} }],
          finishReason: "tool_calls",
        },
        // round 2: stop
        { content: "done", finishReason: "stop" },
      ]),
    };

    await runAgentLoop("hi", {
      ...baseOpts(provider),
      provider,
      session,
      tools: [probe],
      maxToolRounds: 2,
    });

    expect(captured).toBeDefined();
    expect(captured!.workingMemory).toBeInstanceOf(Map);
    expect(captured!.projectId).toBe("proj_42");
  });

  it("workingMemory is shared across tool calls within the same loop", async () => {
    const writer: Tool = {
      name: "write_scratch",
      description: "writes to working memory",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async (_args, context) => {
        context.workingMemory?.set("scratch", "value-from-writer");
        return { success: true, output: "wrote" };
      },
    };

    let readBack: string | undefined;
    const reader: Tool = {
      name: "read_scratch",
      description: "reads from working memory",
      parameters: { type: "object", properties: {}, required: [] },
      execute: async (_args, context) => {
        readBack = context.workingMemory?.get("scratch");
        return { success: true, output: readBack ?? "(empty)" };
      },
    };

    const session = newSession(db, "fake-model", "fake", undefined, "p");
    const provider: AIProvider = {
      id: "fake",
      name: "fake",
      supportsTools: true,
      chat: vi_chat([
        {
          content: "",
          toolCalls: [{ id: "tc1", name: "write_scratch", arguments: {} }],
          finishReason: "tool_calls",
        },
        {
          content: "",
          toolCalls: [{ id: "tc2", name: "read_scratch", arguments: {} }],
          finishReason: "tool_calls",
        },
        { content: "done", finishReason: "stop" },
      ]),
    };

    await runAgentLoop("hi", {
      ...baseOpts(provider),
      provider,
      session,
      tools: [writer, reader],
      maxToolRounds: 3,
    });

    expect(readBack).toBe("value-from-writer");
  });
});

// Helper: scripted multi-turn chat. Kept inline so the test file is self-contained.
function vi_chat(replies: Array<{ content: string; toolCalls?: unknown; finishReason: string }>) {
  let i = 0;
  return async () => {
    const r = replies[Math.min(i, replies.length - 1)];
    i++;
    return {
      content: r.content,
      toolCalls: r.toolCalls,
      usage: { input: 0, output: 0 },
      finishReason: r.finishReason,
    } as unknown as ReturnType<AIProvider["chat"]> extends Promise<infer X> ? X : never;
  };
}
