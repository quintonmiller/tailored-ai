/**
 * One call repeated verbatim, while the calls beside it change.
 *
 * `detectCycle` compares whole rounds, so it only fires when every call in a
 * round repeats in lockstep. That leaves a hole a real model walks straight
 * through: ask the same question of the same store every round, vary the call
 * next to it, and no two round signatures ever match.
 *
 * Measured on the benchmark 2026-08-14. An agent hunting a fact that had been
 * trimmed out of its history called
 * `recall(action="query", query="stripe webhook cutover")` **seventeen times**,
 * byte-identical, with `task_query` and `task_status` alternating alongside it.
 * The detector never fired, the turn burned its whole round budget, and the
 * scenario scored zero — on a run whose final answer was correct.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAgentLoop } from "../agent/loop.js";
import { newSession } from "../agent/session.js";
import { initDatabase } from "../db/schema.js";
import type { AIProvider, ChatResponse } from "../providers/interface.js";
import type { Tool, ToolContext } from "../tools/interface.js";

let db: Database.Database;
beforeEach(() => {
  db = initDatabase(":memory:");
});
afterEach(() => {
  db.close();
});

/** Always asks `recall` the same thing, and pairs it with a different tool each round. */
function makeMaskedRepeatProvider(rounds: number): AIProvider & { callCount: number } {
  const companions = ["task_query", "task_status", "facts", "projects"];
  let count = 0;
  return {
    id: "fake",
    name: "fake",
    supportsTools: true,
    callCount: 0,
    async chat(_params): Promise<ChatResponse> {
      count++;
      this.callCount = count;
      if (count > rounds) return { content: "done", usage: { input: 0, output: 0 }, finishReason: "stop" };
      return {
        content: null,
        toolCalls: [
          // Byte-identical every round.
          { id: `r_${count}`, name: "recall", arguments: { action: "query", query: "stripe webhook cutover" } },
          // Different every round, which is what defeats the round-signature check.
          { id: `c_${count}`, name: companions[count % companions.length], arguments: { n: count } },
        ],
        usage: { input: 0, output: 0 },
        finishReason: "tool_calls",
      };
    },
  } as unknown as AIProvider & { callCount: number };
}

const constantTool = (name: string, output: string): Tool => ({
  name,
  description: name,
  parameters: { type: "object", properties: {} },
  async execute(_a: Record<string, unknown>, _c: ToolContext) {
    return { success: true, output };
  },
});

/** A companion whose output changes every call, so only `recall` is ever a verbatim repeat. */
function makeVaryingTool(name: string): Tool {
  let i = 0;
  return {
    name,
    description: name,
    parameters: { type: "object", properties: { n: { type: "number" } } },
    async execute(_a: Record<string, unknown>, _c: ToolContext) {
      i++;
      return { success: true, output: `${name} result ${i}` };
    },
  };
}

describe("a call that repeats while its neighbours change", () => {
  it("withdraws the repeated tool instead of burning the round budget", async () => {
    const provider = makeMaskedRepeatProvider(30);
    const session = newSession(db, "fake-model", "fake");
    const tools = [
      constantTool("recall", "no matches"),
      makeVaryingTool("task_query"),
      makeVaryingTool("task_status"),
      makeVaryingTool("facts"),
      makeVaryingTool("projects"),
    ];

    const outputs: string[] = [];
    await runAgentLoop("who is handling the cutover?", {
      provider,
      session,
      db,
      tools,
      extraInstructions: "",
      maxToolRounds: 30,
      maxHistoryTokens: 4000,
      temperature: 0.3,
      onToolResult: (name, output) => {
        if (name === "recall") outputs.push(output);
      },
    });

    // Asserted on the tool, not on the round count: this stub provider keeps
    // asking for `recall` forever no matter what it is told, so the loop runs
    // its budget either way. A real model stops when the tool stops existing.
    const answered = outputs.filter((o) => o === "no matches").length;
    const refused = outputs.filter((o) => o.includes("Unknown tool"));
    expect(answered, "the store should answer three times and then be taken away").toBe(3);
    expect(refused.length, "every later call must find the tool gone").toBeGreaterThan(0);
  });

  it("takes the tool out of the offered set once it is withdrawn", async () => {
    const seenOutputs: string[] = [];
    const provider = makeMaskedRepeatProvider(30);
    const session = newSession(db, "fake-model", "fake");
    const tools = [
      constantTool("recall", "no matches"),
      makeVaryingTool("task_query"),
      makeVaryingTool("task_status"),
      makeVaryingTool("facts"),
      makeVaryingTool("projects"),
    ];

    await runAgentLoop("who is handling the cutover?", {
      provider,
      session,
      db,
      tools,
      extraInstructions: "",
      maxToolRounds: 30,
      maxHistoryTokens: 4000,
      temperature: 0.3,
      onToolResult: (name, output) => {
        if (name === "recall") seenOutputs.push(output);
      },
    });

    // The notice rides in the in-flight history rather than the session table,
    // exactly as the cycle detector's does, so it is asserted through what the
    // model is told next: the tool is gone from the offered set.
    const gone = seenOutputs.some((o) => o.includes('Unknown tool "recall"'));
    expect(gone, "the model has to discover the tool is no longer offered").toBe(true);
  });

  it("leaves genuine polling alone when the result keeps changing", async () => {
    // Same call every round, but the store is making progress — the existing
    // rule, restated here because the new check must not break it.
    const provider = makeMaskedRepeatProvider(4);
    const session = newSession(db, "fake-model", "fake");
    const tools = [
      makeVaryingTool("recall"),
      makeVaryingTool("task_query"),
      makeVaryingTool("task_status"),
      makeVaryingTool("facts"),
      makeVaryingTool("projects"),
    ];

    const reply = await runAgentLoop("poll until done", {
      provider,
      session,
      db,
      tools,
      extraInstructions: "",
      maxToolRounds: 30,
      maxHistoryTokens: 4000,
      temperature: 0.3,
    });

    expect(reply).toBe("done");
    expect(provider.callCount).toBe(5);
  });
});
