import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectCycle, type LoopStop, MAX_CYCLE_PERIOD, runAgentLoop } from "../agent/loop.js";
import { newSession } from "../agent/session.js";
import { initDatabase } from "../db/schema.js";
import type { AIProvider, ChatParams, ChatResponse } from "../providers/interface.js";
import type { Tool, ToolResult } from "../tools/interface.js";

/**
 * The stall detector used to compare each round to the one before it, which
 * sees a cycle of period 1 and nothing else. `A → B → A → B` reset the counter
 * every round and ran to the round limit instead — and that is the more common
 * shape: one benchmark scenario produced both in the same batch, looping on a
 * single call in one run (caught) and alternating two in another (missed).
 *
 * Every case asserts both directions. A detector that only ever fires is worse
 * than none: it would cut short the polling loops the result-signature exists
 * to protect.
 */
describe("detectCycle", () => {
  it("catches three identical rounds, the case that always worked", () => {
    expect(detectCycle(["a", "a", "a"])).toBe(1);
    expect(detectCycle(["a", "a"])).toBeNull();
  });

  it("catches a two-call cycle, which is what ran to the round limit", () => {
    expect(detectCycle(["a", "b", "a", "b"])).toBe(2);
    // Half a cycle is not a cycle: the model may be about to do something else.
    expect(detectCycle(["a", "b", "a"])).toBeNull();
  });

  it("catches a three-call cycle", () => {
    expect(detectCycle(["a", "b", "c", "a", "b", "c"])).toBe(3);
    expect(detectCycle(["a", "b", "c", "a", "b"])).toBeNull();
  });

  it("leaves progress alone, however repetitive it looks", () => {
    // The polling case the result signature protects: same call, moving answer.
    expect(detectCycle(["poll:running", "poll:running", "poll:done"])).toBeNull();
    expect(detectCycle(["a", "b", "c", "d", "e", "f"])).toBeNull();
    // A cycle that broke: the tail is what matters, not that one ever occurred.
    expect(detectCycle(["a", "a", "b", "c"])).toBeNull();
  });

  it("reads only the tail, so an early repeat does not condemn a long turn", () => {
    expect(detectCycle(["x", "x", "y", "z", "p", "q"])).toBeNull();
  });

  it("ignores a cycle longer than it is willing to call a stall", () => {
    // Four distinct steps repeating twice is plausibly a real multi-step task,
    // and at eight rounds most deployments have hit their cap anyway.
    const four = ["a", "b", "c", "d", "a", "b", "c", "d"];
    expect(detectCycle(four)).toBeNull();
    expect(detectCycle(four, 4)).toBe(4);
    expect(MAX_CYCLE_PERIOD).toBe(3);
  });
});

/**
 * End to end, because the unit tests above only exercise code that did not
 * exist before. This is the case with a meaningful control: against the
 * previous detector — which compared each round to the one before it — the
 * alternating model runs to `maxToolRounds` and reports `max-rounds`.
 */
describe("the loop stops on a cycle the old detector could not see", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDatabase(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  /** Alternates two tools forever, the shape observed in the benchmark. */
  function alternating(names: string[]): AIProvider {
    let n = 0;
    return {
      id: "fake",
      name: "fake",
      supportsTools: true,
      async chat(params: ChatParams): Promise<ChatResponse> {
        if (!params.tools?.length) {
          return { content: "no idea", usage: { input: 1, output: 1 }, finishReason: "stop", toolCalls: [] };
        }
        const name = names[n++ % names.length];
        return {
          content: "",
          usage: { input: 1, output: 1 },
          finishReason: "tool_calls",
          toolCalls: [{ id: `c${n}`, name, arguments: {} }],
        };
      },
    } as unknown as AIProvider;
  }

  /** Same answer every time — no progress, which is what makes it a stall. */
  function stuck(name: string): Tool {
    return {
      name,
      description: name,
      parameters: { type: "object", properties: {} },
      async execute(): Promise<ToolResult> {
        return { success: true, output: "nothing found" };
      },
    };
  }

  async function run(names: string[], maxToolRounds: number): Promise<LoopStop | undefined> {
    const session = newSession(db, "fake-model", "fake");
    let stop: LoopStop | undefined;
    await runAgentLoop("file a task when the migration is done", {
      db,
      session,
      provider: alternating(names),
      tools: names.map(stuck),
      systemPrompt: "test",
      maxToolRounds,
      maxHistoryTokens: 4000,
      onStop: (s) => {
        stop = s;
      },
    });
    return stop;
  }

  it("reports the alternation as a stall, with its period", async () => {
    // Ten rounds available and it stops at four, so this is the detector
    // firing rather than the round limit arriving first.
    expect(await run(["task_query", "recall"], 10)).toEqual({ kind: "repeated-calls", period: 2 });
  });

  it("still catches a single repeated call", async () => {
    expect(await run(["task_query"], 10)).toEqual({ kind: "repeated-calls", period: 1 });
  });
});

/**
 * Stopping a cycle early must not cost the turn its answer.
 *
 * The round limit has asked once more with the tools withheld since #470,
 * because a stalled agent has usually already read what it needed. Widening the
 * detector in #499 gave more turns the cycle exit — and that exit returned a
 * marker, so two benchmark runs that had been answering became stall markers.
 */
describe("a turn stopped for cycling still gets asked for an answer", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = initDatabase(":memory:");
  });
  afterEach(() => {
    db.close();
  });

  it("returns the prose from the tools-withheld call, not a marker", async () => {
    let withheldCalls = 0;
    const provider = {
      id: "fake",
      name: "fake",
      supportsTools: true,
      async chat(params: ChatParams): Promise<ChatResponse> {
        if (!params.tools?.length) {
          withheldCalls++;
          return {
            content: "The retry limit is 5.",
            usage: { input: 1, output: 1 },
            finishReason: "stop",
            toolCalls: [],
          };
        }
        return {
          content: "",
          usage: { input: 1, output: 1 },
          finishReason: "tool_calls",
          toolCalls: [{ id: "c", name: "look", arguments: {} }],
        };
      },
    } as unknown as AIProvider;

    const session = newSession(db, "fake-model", "fake");
    let stop: LoopStop | undefined;
    const reply = await runAgentLoop("what is the retry limit?", {
      db,
      session,
      provider,
      tools: [
        {
          name: "look",
          description: "look",
          parameters: { type: "object", properties: {} },
          async execute(): Promise<ToolResult> {
            return { success: true, output: "nothing found" };
          },
        },
      ],
      systemPrompt: "test",
      maxToolRounds: 10,
      maxHistoryTokens: 4000,
      onStop: (s) => {
        stop = s;
      },
    });

    expect(stop).toEqual({ kind: "repeated-calls", period: 1 });
    expect(reply).toBe("The retry limit is 5.");
    expect(reply).not.toContain("[Agent stopped");
    expect(withheldCalls).toBe(1);
  });
});
