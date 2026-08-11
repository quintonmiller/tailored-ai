import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isStallStop, type LoopStop, runAgentLoop } from "../agent/loop.js";
import { newSession } from "../agent/session.js";
import { initDatabase } from "../db/schema.js";
import type { AIProvider, ChatResponse } from "../providers/interface.js";
import type { Tool, ToolContext, ToolResult } from "../tools/interface.js";

/**
 * `ToolResult.endsTurn` — a tool ending the agent's turn on its own say-so.
 *
 * The behaviour these protect was measured, not imagined: `room(action="pass")`
 * used to return an ordinary result, so the loop asked the model what to do
 * next, and a 27B model answered by passing again. Three full prompts went out
 * for one decision, and the turn exited through the repeated-call detector —
 * reported as a stall, which is the opposite of what happened.
 */

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

/** Always asks for the same tool, so a loop that does not stop keeps going. */
function alwaysCallsTool(name: string, content: string | null = null): AIProvider & { calls: number } {
  return {
    id: "fake",
    name: "fake",
    supportsTools: true,
    calls: 0,
    async chat(): Promise<ChatResponse> {
      this.calls++;
      return {
        content,
        usage: { input: 0, output: 0 },
        finishReason: "tool_calls",
        toolCalls: [{ id: `call-${this.calls}`, name, arguments: {} }],
      };
    },
  } as unknown as AIProvider & { calls: number };
}

function toolReturning(name: string, result: ToolResult): Tool {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    async execute(_args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
      return result;
    },
  };
}

async function run(provider: AIProvider, tools: Tool[]) {
  const session = newSession(db, "fake-model", "fake");
  let stop: LoopStop | undefined;
  const reply = await runAgentLoop("go", {
    db,
    session,
    provider,
    tools,
    systemPrompt: "test",
    maxToolRounds: 10,
    onStop: (s) => {
      stop = s;
    },
  });
  return { reply, stop };
}

describe("ToolResult.endsTurn", () => {
  it("stops after one round instead of running until the repeat detector fires", async () => {
    const provider = alwaysCallsTool("done");
    const tool = toolReturning("done", { success: true, output: "finished", endsTurn: true });

    const { stop } = await run(provider, [tool]);

    // One call, not three. Three is what the repeated-call detector allows, and
    // is exactly what this costs when the flag is not honoured.
    expect(provider.calls).toBe(1);
    expect(stop?.kind).toBe("tool-ended");
  });

  it("names the tool that ended the turn and is not a stall", async () => {
    const provider = alwaysCallsTool("done");
    const tool = toolReturning("done", { success: true, output: "finished", endsTurn: true });

    const { stop } = await run(provider, [tool]);

    expect(stop).toEqual({ kind: "tool-ended", tool: "done", reason: undefined });
    // The distinction the old path got wrong: a deliberate stop reported as a
    // stall makes callers that branch on it (exploratory worker) log an error
    // for a tick that worked.
    expect(stop && isStallStop(stop)).toBe(false);
  });

  it("returns endsTurnReason when the tool supplies one", async () => {
    const provider = alwaysCallsTool("done", "model chatter that should lose");
    const tool = toolReturning("done", {
      success: true,
      output: "finished",
      endsTurn: true,
      endsTurnReason: "[Sleep] nothing worth doing",
    });

    const { reply } = await run(provider, [tool]);

    expect(reply).toBe("[Sleep] nothing worth doing");
  });

  it("falls back to the model's own text when no reason is given", async () => {
    const provider = alwaysCallsTool("quiet", "all I had to say");
    const tool = toolReturning("quiet", { success: true, output: "ok", endsTurn: true });

    const { reply } = await run(provider, [tool]);

    expect(reply).toBe("all I had to say");
    // Asserted alongside the text because the text alone does not distinguish
    // this from the unfixed path: the repeated-call detector also returns the
    // model's content, just two round-trips later. The call count is what makes
    // this test about `endsTurn` rather than about the detector.
    expect(provider.calls).toBe(1);
  });

  it("returns empty rather than a terminator when the model said nothing", async () => {
    // The room `pass` shape. Anything non-empty here is a string the watcher
    // would have to know to suppress before it reached a room.
    const provider = alwaysCallsTool("quiet", null);
    const tool = toolReturning("quiet", { success: true, output: "Saying nothing this turn.", endsTurn: true });

    const { reply } = await run(provider, [tool]);

    expect(reply).toBe("");
  });

  it("records the tool result in history before stopping", async () => {
    const provider = alwaysCallsTool("done");
    const tool = toolReturning("done", { success: true, output: "the tool ran", endsTurn: true });
    const session = newSession(db, "fake-model", "fake");

    await runAgentLoop("go", {
      db,
      session,
      provider,
      tools: [tool],
      systemPrompt: "test",
      maxToolRounds: 10,
    });

    const rows = db
      .prepare("SELECT role, content FROM messages WHERE session_id = ? AND role = 'tool'")
      .all(session.id) as Array<{ content: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toContain("the tool ran");
  });

  it("ends the turn even when the tool reports failure", async () => {
    // Whether a tool succeeded and whether it meant to stop are separate
    // questions. Gating on success would leave a tool that failed *and* wanted
    // to stop looping until the detector caught it.
    const provider = alwaysCallsTool("done");
    const tool = toolReturning("done", { success: false, output: "", error: "nope", endsTurn: true });

    const { stop } = await run(provider, [tool]);

    expect(provider.calls).toBe(1);
    expect(stop?.kind).toBe("tool-ended");
  });

  it("leaves a tool that does not set the flag running until the detector stops it", async () => {
    const provider = alwaysCallsTool("chatty");
    const tool = toolReturning("chatty", { success: true, output: "same every time" });

    const { stop } = await run(provider, [tool]);

    // Unchanged behaviour: the repeat detector is not weakened by this change,
    // only reached less often.
    expect(stop?.kind).toBe("repeated-calls");
    // Three rounds to trip the detector, then one more with the tools withheld
    // — a turn stopped for cycling is still asked for an answer, the same way a
    // turn stopped by the round limit has been since #470. `endsTurn` is what
    // this file is about, and it saves all four.
    expect(provider.calls).toBe(4);
  });
});
