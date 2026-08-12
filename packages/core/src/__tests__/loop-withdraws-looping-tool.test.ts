/**
 * A cycling tool is taken away, and the turn carries on.
 *
 * The cycle detector used to end the turn outright. That is right when the cycle
 * *is* the turn, and wrong when it is one blind alley inside a turn that still
 * has work available — which is the more common shape once an agent holds more
 * than a couple of tools.
 *
 * Measured before this existed: a model asked for a fact that had fallen out of
 * its history window called an empty `core_memory` three times, tripped the
 * detector, and the turn ended — with rounds still on the budget and a tool it
 * had never touched sitting in the list. Two of six runs happened to try that
 * tool first and passed; four looped first and lost the turn to it.
 *
 * Withdrawing rather than persuading, and that is the part worth pinning.
 * Talking the model out of the loop was tried three ways and none of them moved
 * the number: making the empty result say "reading again returns this", telling
 * it at the moment of the repeat that the call was identical, and refusing the
 * third call outright with an explanation. The refusal was the clearest signal
 * and the worst outcome — the model kept calling into it, five to seven times.
 * A tool that is not offered is the one thing it cannot call.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isStallStop, type LoopStop, runAgentLoop } from "../agent/loop.js";
import { newSession } from "../agent/session.js";
import { initDatabase } from "../db/schema.js";
import type { AIProvider, ChatParams, ChatResponse } from "../providers/interface.js";
import type { Tool, ToolResult } from "../tools/interface.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

/** What the model was offered on each round, so "it was withdrawn" is observable. */
interface Recorder {
  offered: string[][];
  calls: number;
  used: boolean;
}

/**
 * Loops on `stuck` until it is gone, then calls `escape` once and answers.
 *
 * The shape of the real failure: the agent is not broken, it is fixated. Given
 * anything else to do it does it.
 */
function fixatedProvider(stuck: string, alternate: string): AIProvider & Recorder {
  return {
    id: "fake",
    name: "fake",
    supportsTools: true,
    offered: [] as string[][],
    calls: 0,
    used: false,
    async chat(params: ChatParams): Promise<ChatResponse> {
      this.calls++;
      const names = (params.tools ?? []).map((t) => t.function.name);
      this.offered.push(names);
      if (names.includes(stuck)) {
        return {
          content: null,
          usage: { input: 0, output: 0 },
          finishReason: "tool_calls",
          toolCalls: [{ id: `call-${this.calls}`, name: stuck, arguments: {} }],
        };
      }
      // Once, then answer. A fixture that keeps calling the escape tool would
      // simply cycle on that instead and re-enter the path under test, which is
      // realistic but tests nothing about the first withdrawal.
      if (names.includes(alternate) && !this.used) {
        this.used = true;
        return {
          content: null,
          usage: { input: 0, output: 0 },
          finishReason: "tool_calls",
          toolCalls: [{ id: `call-${this.calls}`, name: alternate, arguments: {} }],
        };
      }
      return { content: "done, using what was left", usage: { input: 0, output: 0 }, finishReason: "stop" };
    },
  } as unknown as AIProvider & Recorder;
}

function toolReturning(name: string, result: ToolResult): Tool {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    async execute(): Promise<ToolResult> {
      return result;
    },
  };
}

async function run(provider: AIProvider, tools: Tool[], maxToolRounds = 10) {
  const session = newSession(db, "fake-model", "fake");
  let stop: LoopStop | undefined;
  const reply = await runAgentLoop("go", {
    db,
    session,
    provider,
    tools,
    systemPrompt: "test",
    maxToolRounds,
    onStop: (s) => {
      stop = s;
    },
  });
  return { reply, stop };
}

const EMPTY = { success: true, output: "(nothing stored)" };

describe("a tool the model is cycling on", () => {
  it("is withdrawn, and the turn continues with what is left", async () => {
    const provider = fixatedProvider("stuck", "escape");

    const { reply, stop } = await run(provider, [
      toolReturning("stuck", EMPTY),
      toolReturning("escape", { success: true, output: "the answer" }),
    ]);

    // The tool disappears from the offered list part-way through the turn, which
    // is the mechanism rather than a consequence of it.
    expect(provider.offered[0]).toContain("stuck");
    expect(provider.offered.at(-1)).not.toContain("stuck");
    // And the turn reached an answer instead of ending on the cycle.
    expect(reply).toBe("done, using what was left");
    expect(stop && isStallStop(stop)).toBe(false);
  });

  it("tells the model what was withdrawn, rather than letting a tool vanish silently", async () => {
    // A tool disappearing from the list with no explanation is a change the
    // model can only read as its own mistake. Saying so costs one line and
    // names the thing it should stop trying.
    const seen: string[] = [];
    const provider = {
      id: "fake",
      name: "fake",
      supportsTools: true,
      calls: 0,
      async chat(params: ChatParams): Promise<ChatResponse> {
        this.calls++;
        const names = (params.tools ?? []).map((t) => t.function.name);
        seen.push(params.messages.map((m) => m.content ?? "").join("\n"));
        if (names.includes("stuck")) {
          return {
            content: null,
            usage: { input: 0, output: 0 },
            finishReason: "tool_calls",
            toolCalls: [{ id: `c${this.calls}`, name: "stuck", arguments: {} }],
          };
        }
        return { content: "ok", usage: { input: 0, output: 0 }, finishReason: "stop" };
      },
    } as unknown as AIProvider;

    await run(provider, [toolReturning("stuck", EMPTY), toolReturning("escape", { success: true, output: "ok" })]);

    const afterWithdrawal = seen.at(-1) ?? "";
    expect(afterWithdrawal).toContain("stuck");
    expect(afterWithdrawal).toContain("withdrawn for the rest of this turn");
  });

  it("still ends the turn when there is nothing else to offer", async () => {
    // With one tool, withdrawing it leaves nothing — so this is the terminal
    // path by another name, and the honest stop beats a round spent proving it.
    // The pre-existing behaviour, unchanged, and the reason the old cycle tests
    // still pass untouched.
    const provider = fixatedProvider("stuck", "absent");

    const { stop } = await run(provider, [toolReturning("stuck", EMPTY)]);

    expect(stop?.kind).toBe("repeated-calls");
    expect(stop && isStallStop(stop)).toBe(true);
  });

  it("withdraws every tool in an alternating cycle, not just the last one", async () => {
    // `A → B → A → B` is the period-2 case. Withdrawing only the tool named in
    // the final round would leave the other half of the cycle in place and the
    // model free to fixate on it instead.
    let calls = 0;
    const provider = {
      id: "fake",
      name: "fake",
      supportsTools: true,
      offered: [] as string[][],
      async chat(params: ChatParams): Promise<ChatResponse> {
        calls++;
        const names = (params.tools ?? []).map((t) => t.function.name);
        this.offered.push(names);
        const pair = names.filter((n) => n === "left" || n === "right");
        if (pair.length === 2) {
          return {
            content: null,
            usage: { input: 0, output: 0 },
            finishReason: "tool_calls",
            toolCalls: [{ id: `c${calls}`, name: calls % 2 === 1 ? "left" : "right", arguments: {} }],
          };
        }
        return { content: "moved on", usage: { input: 0, output: 0 }, finishReason: "stop" };
      },
    } as unknown as AIProvider & { offered: string[][] };

    const { reply } = await run(provider, [
      toolReturning("left", EMPTY),
      toolReturning("right", EMPTY),
      toolReturning("other", { success: true, output: "fine" }),
    ]);

    const last = provider.offered.at(-1) ?? [];
    expect(last).not.toContain("left");
    expect(last).not.toContain("right");
    expect(last).toContain("other");
    expect(reply).toBe("moved on");
  });

  it("does not withdraw a tool that is making progress", async () => {
    // The polling case. Same call, moving answer — `detectCycle` reads the
    // result into the signature, so this never trips, and a withdrawal here
    // would break every long-running job an agent watches.
    let calls = 0;
    const provider = {
      id: "fake",
      name: "fake",
      supportsTools: true,
      offered: [] as string[][],
      async chat(params: ChatParams): Promise<ChatResponse> {
        calls++;
        this.offered.push((params.tools ?? []).map((t) => t.function.name));
        if (calls > 4) return { content: "finished", usage: { input: 0, output: 0 }, finishReason: "stop" };
        return {
          content: null,
          usage: { input: 0, output: 0 },
          finishReason: "tool_calls",
          toolCalls: [{ id: `c${calls}`, name: "poll", arguments: {} }],
        };
      },
    } as unknown as AIProvider & { offered: string[][] };

    let step = 0;
    const poll: Tool = {
      name: "poll",
      description: "poll",
      parameters: { type: "object", properties: {} },
      async execute(): Promise<ToolResult> {
        step++;
        return { success: true, output: `step ${step}` };
      },
    };

    const { reply } = await run(provider, [poll, toolReturning("other", EMPTY)]);

    expect(provider.offered.every((names) => names.includes("poll"))).toBe(true);
    expect(reply).toBe("finished");
  });
});
