/**
 * Tool definitions ride in their own request field rather than in a message, so
 * nothing that walked the message list ever measured them — and the history
 * budget was computed by walking the message list.
 *
 * The model reads them regardless. On a production deployment 42 tools
 * serialise to ~10,857 tokens, so the request went out about 10% over the
 * budget it was sized against, every turn, and each fallback rung inherited the
 * same error against a window that is usually tighter.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { estimateToolSchemaTokens, runAgentLoop } from "../agent/loop.js";
import { newSession } from "../agent/session.js";
import { saveMessage } from "../db/queries.js";
import { initDatabase } from "../db/schema.js";
import type { AIProvider, ChatParams, ChatResponse } from "../providers/interface.js";
import type { Tool, ToolContext, ToolResult } from "../tools/interface.js";

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

/** A tool whose schema is deliberately bulky, standing in for a real 42-tool set. */
function fatTool(n: number): Tool {
  return {
    name: `tool_${n}`,
    description: "x".repeat(400),
    parameters: {
      type: "object",
      properties: {
        arg: { type: "string", description: "y".repeat(400) },
      },
    },
    async execute(_args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      return { output: "done" };
    },
  } as unknown as Tool;
}

function seedHistory(sessionId: string, count: number): void {
  for (let i = 0; i < count; i++) {
    saveMessage(db, sessionId, { role: "user", content: `msg ${i} ${"z".repeat(200)}` });
    saveMessage(db, sessionId, { role: "assistant", content: `reply ${i}` });
  }
}

function run(seen: ChatParams[], over: Record<string, unknown> = {}) {
  const session = newSession(db, "fake-model", "fake");
  seedHistory(session.id, 40);
  return runAgentLoop("go", {
    provider: recordingProvider(seen),
    session,
    db,
    tools: [],
    extraInstructions: "",
    maxToolRounds: 2,
    maxHistoryTokens: 5000,
    temperature: 0.3,
    ...over,
  });
}

describe("estimateToolSchemaTokens", () => {
  it("is zero when there are no tools, so a toolless agent pays nothing", () => {
    expect(estimateToolSchemaTokens(undefined)).toBe(0);
    expect(estimateToolSchemaTokens([])).toBe(0);
  });

  it("grows with the schemas, which is the whole point", () => {
    const one = estimateToolSchemaTokens([{ name: "a", description: "d", parameters: { type: "object" } }]);
    const many = estimateToolSchemaTokens(
      Array.from({ length: 10 }, (_, i) => ({ name: `a${i}`, description: "d", parameters: { type: "object" } })),
    );
    expect(one).toBeGreaterThan(0);
    expect(many).toBeGreaterThan(one * 5);
  });
});

describe("tool schemas are charged against the history budget", () => {
  it("leaves less room for history than the same turn with no tools", async () => {
    const withoutTools: ChatParams[] = [];
    const withTools: ChatParams[] = [];

    await run(withoutTools);
    await run(withTools, { tools: Array.from({ length: 12 }, (_, i) => fatTool(i)) });

    const historyOf = (p: ChatParams) => p.messages.filter((m) => m.role !== "system").length;
    // The budget is fixed, so the schemas have to come out of the history.
    // Before this, both requests carried the same history and the second was
    // simply larger than the budget allowed for.
    expect(historyOf(withTools[0])).toBeLessThan(historyOf(withoutTools[0]));
  });

  it("keeps the whole request inside the budget it was sized against", async () => {
    const seen: ChatParams[] = [];
    const tools = Array.from({ length: 12 }, (_, i) => fatTool(i));

    await run(seen, { tools, maxHistoryTokens: 5000 });

    const chars =
      seen[0].messages.reduce((n, m) => n + (m.content ?? "").length, 0) + JSON.stringify(seen[0].tools).length;
    expect(Math.ceil(chars / 4)).toBeLessThanOrEqual(5000);
  });

  it("still sends the tools — the budget shrinks, the request does not lose them", async () => {
    const seen: ChatParams[] = [];
    await run(seen, { tools: Array.from({ length: 12 }, (_, i) => fatTool(i)) });

    expect(seen[0].tools).toHaveLength(12);
  });
});
