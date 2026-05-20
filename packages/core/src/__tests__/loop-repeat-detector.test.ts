import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newSession } from "../agent/session.js";
import { runAgentLoop } from "../agent/loop.js";
import { initDatabase } from "../db/schema.js";
import type { AIProvider, ChatResponse } from "../providers/interface.js";
import type { Tool, ToolContext } from "../tools/interface.js";

/**
 * Regression tests for the "repeated identical tool calls" guard in
 * `runAgentLoop`. The guard aborts the loop when the model appears stuck —
 * but legitimate polling (e.g. `task_status` running → running → completed)
 * looks identical on the call side. The detector should only fire when both
 * the call AND its result are unchanged across rounds.
 */

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

/**
 * Provider that always returns the same single tool call, until it's been
 * called `stopAfter` times, then returns plain content to terminate normally.
 */
function makeRepeatingProvider(stopAfter: number): AIProvider & { callCount: number } {
  let count = 0;
  return {
    id: "fake",
    name: "fake",
    supportsTools: true,
    callCount: 0,
    async chat(): Promise<ChatResponse> {
      count++;
      this.callCount = count;
      if (count > stopAfter) {
        return { content: "done", usage: { input: 0, output: 0 }, finishReason: "stop" };
      }
      return {
        content: null,
        toolCalls: [
          { id: `tc_${count}`, name: "poll", arguments: { id: "task_x" } },
        ],
        usage: { input: 0, output: 0 },
        finishReason: "tool_calls",
      };
    },
  } as AIProvider & { callCount: number };
}

function makePollTool(results: string[]): Tool {
  let i = 0;
  return {
    name: "poll",
    description: "Fake polling tool",
    parameters: { type: "object", properties: { id: { type: "string" } } },
    async execute(_args: Record<string, unknown>, _ctx: ToolContext) {
      const out = results[Math.min(i, results.length - 1)];
      i++;
      return { success: true, output: out };
    },
  };
}

describe("runAgentLoop repeated-call detector", () => {
  it("does NOT abort when the same call returns different results (polling)", async () => {
    // Three calls with three different results — classic async polling shape.
    const provider = makeRepeatingProvider(3);
    const session = newSession(db, "fake-model", "fake");
    const tool = makePollTool(["running 1s", "running 5s", "completed"]);

    const response = await runAgentLoop("poll until done", {
      provider,
      session,
      db,
      tools: [tool],
      extraInstructions: "",
      maxToolRounds: 10,
      maxHistoryTokens: 2000,
      temperature: 0.3,
    });

    expect(response).toBe("done");
    // 4 chat calls total: 3 with tool calls + 1 that returns final content.
    expect(provider.callCount).toBe(4);
  });

  it("DOES abort when same call returns same result three times (stuck)", async () => {
    // Same call, same result, repeated — the agent is genuinely stuck.
    const provider = makeRepeatingProvider(10);
    const session = newSession(db, "fake-model", "fake");
    const tool = makePollTool(["same answer"]);

    const response = await runAgentLoop("loop forever", {
      provider,
      session,
      db,
      tools: [tool],
      extraInstructions: "",
      maxToolRounds: 10,
      maxHistoryTokens: 2000,
      temperature: 0.3,
    });

    expect(response).toContain("repeated identical tool calls");
    // Should have aborted before exhausting the 10 round budget.
    expect(provider.callCount).toBeLessThan(10);
  });
});
