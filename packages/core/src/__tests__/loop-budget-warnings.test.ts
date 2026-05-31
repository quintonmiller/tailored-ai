import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgentLoop } from "../agent/loop.js";
import { newSession } from "../agent/session.js";
import { initDatabase } from "../db/schema.js";
import type { AIProvider, ChatResponse, Message } from "../providers/interface.js";
import type { Tool, ToolContext } from "../tools/interface.js";

/**
 * Regression tests for the `budgetWarnings` opt-in (Phase 6 follow-up:
 * coder stall mitigation). When the flag is true, the loop should inject
 * `[System: tool-budget check — …]` reminders at the halfway and 80% marks.
 * When the flag is false (default), no extra system messages appear.
 */

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

/**
 * Provider that fires N tool calls, then ends with content. Records every
 * `messages` payload it was given so the test can inspect injected system
 * reminders.
 */
function makeRecordingProvider(toolCallsBeforeStop: number) {
  let count = 0;
  const seen: Message[][] = [];
  const provider: AIProvider = {
    id: "fake",
    name: "fake",
    supportsTools: true,
    async chat({ messages }): Promise<ChatResponse> {
      seen.push([...messages]);
      count++;
      if (count > toolCallsBeforeStop) {
        return { content: "done", usage: { input: 0, output: 0 }, finishReason: "stop" };
      }
      return {
        content: null,
        toolCalls: [{ id: `tc_${count}`, name: "noop", arguments: { i: count } }],
        usage: { input: 0, output: 0 },
        finishReason: "tool_calls",
      };
    },
  };
  return { provider, seen };
}

const noopTool: Tool = {
  name: "noop",
  description: "no-op",
  parameters: { type: "object", properties: {} },
  async execute(_args: Record<string, unknown>, _ctx: ToolContext) {
    return { success: true, output: "ok" };
  },
};

function lastUserSystemReminders(messages: Message[][]): string[] {
  // Every chat call gets the cumulative history. The newest reminders are
  // visible in the LAST payload. Pull every `user`-role message whose
  // content begins with `[System: tool-budget check` or `[System: only N rounds`.
  const last = messages[messages.length - 1] ?? [];
  return last
    .filter((m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("[System: "))
    .map((m) => m.content as string);
}

describe("runAgentLoop budgetWarnings", () => {
  it("injects no system reminders when budgetWarnings is off (default)", async () => {
    const { provider, seen } = makeRecordingProvider(8);
    const session = newSession(db, "fake-model", "fake");
    await runAgentLoop("go", {
      provider,
      session,
      db,
      tools: [noopTool],
      extraInstructions: "",
      maxToolRounds: 10,
      maxHistoryTokens: 5000,
      temperature: 0.3,
    });
    const reminders = lastUserSystemReminders(seen);
    expect(reminders).toEqual([]);
  });

  it("injects the half-budget reminder at floor(maxToolRounds * 0.5)", async () => {
    const { provider, seen } = makeRecordingProvider(8);
    const session = newSession(db, "fake-model", "fake");
    await runAgentLoop("go", {
      provider,
      session,
      db,
      tools: [noopTool],
      extraInstructions: "",
      maxToolRounds: 10,
      maxHistoryTokens: 5000,
      temperature: 0.3,
      budgetWarnings: true,
    });
    const reminders = lastUserSystemReminders(seen);
    const half = reminders.find((r) => r.includes("tool-budget check"));
    expect(half).toBeDefined();
    expect(half).toContain("5/10 rounds used");
  });

  it("injects the near-end reminder at floor(maxToolRounds * 0.8)", async () => {
    const { provider, seen } = makeRecordingProvider(9);
    const session = newSession(db, "fake-model", "fake");
    await runAgentLoop("go", {
      provider,
      session,
      db,
      tools: [noopTool],
      extraInstructions: "",
      maxToolRounds: 10,
      maxHistoryTokens: 5000,
      temperature: 0.3,
      budgetWarnings: true,
    });
    const reminders = lastUserSystemReminders(seen);
    const near = reminders.find((r) => r.includes("only ") && r.includes("rounds left"));
    expect(near).toBeDefined();
    expect(near).toContain("only 2 rounds left of 10");
  });

  it("does not duplicate reminders across rounds past the threshold", async () => {
    const { provider, seen } = makeRecordingProvider(9);
    const session = newSession(db, "fake-model", "fake");
    await runAgentLoop("go", {
      provider,
      session,
      db,
      tools: [noopTool],
      extraInstructions: "",
      maxToolRounds: 10,
      maxHistoryTokens: 5000,
      temperature: 0.3,
      budgetWarnings: true,
    });
    const reminders = lastUserSystemReminders(seen);
    const halves = reminders.filter((r) => r.includes("tool-budget check"));
    const nears = reminders.filter((r) => r.includes("rounds left"));
    expect(halves.length).toBe(1);
    expect(nears.length).toBe(1);
  });
});
