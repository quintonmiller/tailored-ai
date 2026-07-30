/**
 * The cap where it matters: what a tool call actually leaves behind in the
 * conversation.
 *
 * Capping is done at the single ToolResult→string conversion in
 * executeToolCall, upstream of the tool Message, saveMessage and history.push.
 * A cap applied later would miss one of them — and since every turn reloads
 * history from SQLite, an in-memory-only cap would let the full payload back
 * in on the next round.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../agent/loop.js";
import { newSession } from "../agent/session.js";
import { getSessionMessages } from "../db/queries.js";
import { initDatabase } from "../db/schema.js";
import type { AIProvider, ChatResponse } from "../providers/interface.js";
import type { Tool } from "../tools/interface.js";

let db: Database.Database;
let scratchDir: string;

beforeEach(() => {
  db = initDatabase(":memory:");
  scratchDir = mkdtempSync(join(tmpdir(), "tai-loop-cap-"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

/** Stands in for the Notion search that caused this: one enormous JSON blob. */
const HUGE = `{"results":[${"x".repeat(70_000)}]}`;

const hugeTool = (name: string): Tool => ({
  name,
  description: "returns a lot",
  parameters: { type: "object", properties: {} },
  async execute() {
    return { success: true, output: HUGE };
  },
});

function makeProvider(toolName: string): AIProvider {
  let count = 0;
  return {
    id: "fake",
    name: "fake",
    supportsTools: true,
    async chat(): Promise<ChatResponse> {
      count++;
      if (count > 1) return { content: "done", usage: { input: 0, output: 0 }, finishReason: "stop" };
      return {
        content: null,
        toolCalls: [{ id: "tc_1", name: toolName, arguments: {} }],
        usage: { input: 0, output: 0 },
        finishReason: "tool_calls",
      };
    },
  };
}

function run(toolName: string, over: Record<string, unknown> = {}) {
  return runAgentLoop("go", {
    provider: makeProvider(toolName),
    session: newSession(db, "fake-model", "fake"),
    db,
    tools: [hugeTool(toolName)],
    extraInstructions: "",
    maxToolRounds: 4,
    maxHistoryTokens: 5000,
    temperature: 0.3,
    toolOutputDir: scratchDir,
    ...over,
  });
}

const toolMessages = () => {
  const sessions = db.prepare("SELECT id FROM sessions").all() as { id: string }[];
  return sessions.flatMap((s) => getSessionMessages(db, s.id)).filter((m) => m.role === "tool");
};

describe("runAgentLoop — tool output cap", () => {
  it("persists a bounded tool message, not the full payload", async () => {
    await run("huge_default", { maxToolOutputChars: 2000 });

    const tools = toolMessages();
    expect(tools).toHaveLength(1);
    const content = tools[0].content ?? "";
    expect(content.length).toBeLessThan(HUGE.length);
    expect(content).toContain("chars omitted");
  });

  it("applies the default cap when none is configured", async () => {
    await run("huge_implicit");

    const content = toolMessages()[0].content ?? "";
    // 70k payload against the 32k default.
    expect(content.length).toBeLessThan(HUGE.length);
    expect(content).toContain("truncated to");
  });

  it("lets a per-tool limit override the global one", async () => {
    await run("huge_specific", {
      maxToolOutputChars: 50_000,
      toolOutputLimits: { huge_specific: 1000 },
    });

    const content = toolMessages()[0].content ?? "";
    // Well under the global 50k because the per-tool 1k won.
    expect(content.length).toBeLessThan(5_000);
  });

  it("stores the payload whole when capping is switched off", async () => {
    await run("huge_off", { maxToolOutputChars: 0 });

    expect(toolMessages()[0].content).toBe(HUGE);
  });

  it("keeps the timing suffix outside the truncated body", async () => {
    await run("huge_timing", { maxToolOutputChars: 2000 });

    const content = toolMessages()[0].content ?? "";
    // The marker leads; any timing note the loop appends stays at the end.
    expect(content.startsWith("[huge_timing returned")).toBe(true);
  });
});
