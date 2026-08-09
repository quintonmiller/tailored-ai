import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type LoopStop, runAgentLoop } from "../agent/loop.js";
import { newSession } from "../agent/session.js";
import { getSessionMessages } from "../db/queries.js";
import { initDatabase } from "../db/schema.js";
import type { AIProvider, ChatParams, ChatResponse } from "../providers/interface.js";
import type { Tool, ToolContext, ToolResult } from "../tools/interface.js";

/**
 * What a turn returns when it runs out of tool rounds.
 *
 * It used to return `[Agent stopped: max tool rounds reached]` and throw the
 * turn's work away. Measured on the benchmark's truncation scenario, 11 of 15
 * runs ended that way — and in each one the agent had already read the file,
 * seen where it was cut, and tried three ways round it. It knew the answer and
 * never got asked for it.
 *
 * Silence is also the worst shape for a caller: indistinguishable from a crash,
 * a hang, or an agent that decided not to speak.
 */

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

interface Recorder extends AIProvider {
  requests: Array<Omit<ChatParams, "model">>;
}

/**
 * Reaches for a tool as long as it is offered one, and answers in prose when it
 * is not — the model this fix is for. A model that stops on its own never
 * reaches this exit.
 */
function toolHungry(options: { answer?: string | null; failWithoutTools?: boolean } = {}): Recorder {
  const requests: Array<Omit<ChatParams, "model">> = [];
  return {
    id: "fake",
    name: "fake",
    supportsTools: true,
    requests,
    async chat(params: ChatParams): Promise<ChatResponse> {
      requests.push(params);
      if (params.tools?.length) {
        return {
          content: "Let me try that another way.",
          usage: { input: 10, output: 5 },
          finishReason: "tool_calls",
          toolCalls: [{ id: `call-${requests.length}`, name: "look", arguments: { at: requests.length } }],
        };
      }
      if (options.failWithoutTools) throw new Error("provider exploded");
      return {
        content: options.answer === undefined ? "I read the runbook, but the middle was cut." : options.answer,
        usage: { input: 10, output: 5 },
        finishReason: "stop",
        toolCalls: [],
      };
    },
  } as unknown as Recorder;
}

/** A different result every call, so the repeated-call detector never fires first. */
function counter(name: string, onCall?: () => void): Tool {
  let n = 0;
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    async execute(_args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
      n++;
      onCall?.();
      return { success: true, output: `result ${n}` };
    },
  };
}

async function run(
  provider: AIProvider,
  tools: Tool[],
  extra: Partial<Parameters<typeof runAgentLoop>[1]> = {},
): Promise<{ reply: string; stop?: LoopStop; sessionId: string }> {
  const session = newSession(db, "fake-model", "fake");
  let stop: LoopStop | undefined;
  const reply = await runAgentLoop("what does the runbook say?", {
    db,
    session,
    provider,
    tools,
    systemPrompt: "test",
    maxToolRounds: 3,
    maxHistoryTokens: 4000,
    onStop: (s) => {
      stop = s;
    },
    ...extra,
  });
  return { reply, stop, sessionId: session.id };
}

describe("a turn that runs out of tool rounds", () => {
  it("asks once more with the tools withheld, and returns what the model said", async () => {
    const provider = toolHungry();

    const { reply, stop } = await run(provider, [counter("look")]);

    expect(reply).toBe("I read the runbook, but the middle was cut.");
    expect(reply).not.toContain("[Agent stopped");
    expect(stop).toEqual({ kind: "max-rounds", rounds: 3, answered: true });
  });

  it("withholds the tools rather than asking the model to stop using them", async () => {
    // The mechanism, not a detail. "Please stop calling tools" is an
    // instruction a model can decline, and a model that has spent every round
    // reaching for a tool is the one that will.
    const provider = toolHungry();

    await run(provider, [counter("look")]);

    expect(provider.requests).toHaveLength(4); // 3 rounds, then the final ask
    for (const req of provider.requests.slice(0, 3)) expect(req.tools?.length).toBe(1);
    expect(provider.requests.at(-1)?.tools ?? []).toHaveLength(0);
  });

  it("sends the turn's work with the final ask, which is the point of making it", async () => {
    // Withholding the tools without the transcript would just be asking a model
    // to answer from nothing. The tool results it gathered are the material.
    const provider = toolHungry();

    await run(provider, [counter("look")]);

    const last = provider.requests.at(-1)!;
    const text = last.messages.map((m) => String(m.content ?? "")).join("\n");
    expect(text).toContain("result 3");
    expect(text).toContain("all 3 of its tool rounds");
  });

  it("is still a stall, even though the reply now reads like an ordinary answer", async () => {
    // The whole risk of this change: callers that decided "stalled" by matching
    // the reply string see a perfectly normal sentence from here on.
    const { stop } = await run(toolHungry(), [counter("look")]);

    expect(stop?.kind).toBe("max-rounds");
  });

  it("bills the extra request", async () => {
    // It is one more call to a paid endpoint on a path that used to make none.
    // Unbilled by construction is how a cost hides.
    const seen: number[] = [];
    await run(toolHungry(), [counter("look")], { onUsage: (u) => seen.push(u.output) });

    expect(seen).toHaveLength(4);
  });

  it("leaves the session showing why the model suddenly answered", async () => {
    const { sessionId } = await run(toolHungry(), [counter("look")]);
    const messages = getSessionMessages(db, sessionId);

    const prompt = messages.filter((m) => m.role === "user").at(-1);
    expect(prompt?.content).toContain("all 3 of its tool rounds");
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "I read the runbook, but the middle was cut.",
    });
  });
});

describe("when the last ask cannot produce an answer", () => {
  it("keeps the marker when the model says nothing", async () => {
    // Not an empty string: silence reads as an agent that chose not to speak,
    // which is a different thing and the one a caller cannot act on.
    const { reply, stop } = await run(toolHungry({ answer: "   " }), [counter("look")]);

    expect(reply).toBe("[Agent stopped: max tool rounds reached]");
    expect(stop).toEqual({ kind: "max-rounds", rounds: 3, answered: false });
  });

  it("keeps the marker when the final call fails, rather than throwing", async () => {
    // The turn is already over; this was the salvage attempt. Turning a stall
    // into a rejected promise would break every caller to fix a reply.
    const { reply, stop } = await run(toolHungry({ failWithoutTools: true }), [counter("look")]);

    expect(reply).toBe("[Agent stopped: max tool rounds reached]");
    expect(stop).toEqual({ kind: "max-rounds", rounds: 3, answered: false });
  });

  it("does not spend a request when the caller has already aborted", async () => {
    // Reachable, not hypothetical: an abort raised while the final round's
    // tools are running is never seen by the loop's top-of-round check, so the
    // turn exits through max-rounds with the signal already set. Answering
    // there would be the loop overriding the stop it is about to honour.
    const controller = new AbortController();
    const provider = toolHungry();
    const tool = counter("look", () => controller.abort("token budget"));

    const { reply, stop } = await run(provider, [tool], { signal: controller.signal });

    expect(reply).toBe("[Agent stopped: shutdown requested]");
    expect(stop?.kind).toBe("aborted");
    expect(provider.requests.every((r) => (r.tools?.length ?? 0) > 0)).toBe(true);
  });
});
