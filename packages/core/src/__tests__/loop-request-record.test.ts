/**
 * `agent.request_assembled` — what the model was actually shown.
 *
 * The invariant these tests defend is that the record IS the request, not a
 * description of one. That distinction is the whole of #535: it would be
 * cheaper to store the loop's state and rebuild the request from it later, and
 * it would be wrong, because `paramsFor` re-trims the history for each fallback
 * rung. Which messages went out depends on which rung answered, and a
 * reconstruction from session state cannot know that — it would confidently
 * produce the head rung's request instead. Authoritative and wrong is worse
 * than absent.
 *
 * So the central assertion here is `toBe`, not a deep-equality or hash
 * comparison. A hash of the recorded object against the sent object would pass
 * by construction as long as they are the same object, and would keep passing
 * if someone later inserted a transformation between the record and the wire.
 * Object identity is the claim, so object identity is what is asserted: if a
 * shaping step ever lands after the observer, this file fails.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ContextSlot, clearContextSlots, registerContextSlot } from "../agent/context-slots.js";
import type { ModelCandidate } from "../agent/loop.js";
import { runAgentLoop } from "../agent/loop.js";
import { newSession } from "../agent/session.js";
import { saveMessage } from "../db/queries.js";
import { initDatabase } from "../db/schema.js";
import type { RequestAssembled } from "../events.js";
import { TypedEventBus } from "../events.js";
import type { AIProvider, ChatParams, ChatResponse } from "../providers/interface.js";
import type { Tool } from "../tools/interface.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
  clearContextSlots();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  clearContextSlots();
  db.close();
  vi.restoreAllMocks();
});

/** Answers plainly, and keeps every params object it was handed. */
function capturingProvider(seen: ChatParams[], id = "fake"): AIProvider {
  return {
    id,
    name: id,
    supportsTools: true,
    async chat(params: ChatParams): Promise<ChatResponse> {
      seen.push(params);
      return { content: "ok", usage: { input: 0, output: 0 }, finishReason: "stop" };
    },
  };
}

/** Always asks for the same tool, so the turn runs out of rounds. */
function toolLoopingProvider(seen: ChatParams[]): AIProvider {
  let n = 0;
  return {
    id: "looping",
    name: "looping",
    supportsTools: true,
    async chat(params: ChatParams): Promise<ChatResponse> {
      seen.push(params);
      // The toolless final report has no schemas, and answering it with another
      // tool call would leave the turn with nothing to say.
      if (!params.tools?.length) {
        return { content: "done", usage: { input: 0, output: 0 }, finishReason: "stop" };
      }
      n++;
      return {
        content: "",
        toolCalls: [{ id: `call-${n}`, name: "probe", arguments: {} }],
        usage: { input: 0, output: 0 },
        finishReason: "tool_calls",
      };
    },
  };
}

/** A rung that is down. */
function deadProvider(seen: ChatParams[]): AIProvider {
  return {
    id: "dead",
    name: "dead",
    supportsTools: true,
    async chat(params: ChatParams): Promise<ChatResponse> {
      seen.push(params);
      throw new Error("upstream is down");
    },
  };
}

const probe: Tool = {
  name: "probe",
  description: "does nothing",
  parameters: { type: "object", properties: {} },
  async execute() {
    return { success: true, output: "nothing to report" };
  },
};

function standing(id: string, body: string): ContextSlot {
  return { id, refresh: "reload", render: () => body };
}

function collect(events: TypedEventBus): RequestAssembled[] {
  const seen: RequestAssembled[] = [];
  events.on("agent.request_assembled", (payload) => {
    seen.push(payload);
  });
  return seen;
}

function run(provider: AIProvider, over: Record<string, unknown> = {}) {
  return runAgentLoop("go", {
    provider,
    session: newSession(db, "fake-model", "fake"),
    db,
    tools: [],
    extraInstructions: "",
    maxToolRounds: 2,
    maxHistoryTokens: 5000,
    temperature: 0.3,
    ...over,
  });
}

describe("agent.request_assembled", () => {
  it("records the object the provider was handed, not a copy of it", async () => {
    const events = new TypedEventBus();
    const records = collect(events);
    const sent: ChatParams[] = [];

    await run(capturingProvider(sent), { events });

    expect(records).toHaveLength(1);
    expect(sent).toHaveLength(1);
    // The invariant. Deep equality would also pass here and would go on passing
    // if a later step rewrote the request after this was recorded.
    expect(records[0].params).toBe(sent[0]);
  });

  it("says which round, rung and model, and that the request was answered", async () => {
    const events = new TypedEventBus();
    const records = collect(events);

    await run(capturingProvider([]), { events, toolContextExtras: { agentName: "planner" } });

    expect(records[0]).toMatchObject({
      round: 1,
      phase: "round",
      attempt: 0,
      answered: true,
      agent: "planner",
      model: "fake-model",
      rung: "fake",
    });
  });

  it("records one request per rung that was actually called", async () => {
    const events = new TypedEventBus();
    const records = collect(events);
    const answered: ChatParams[] = [];
    const chain: ModelCandidate[] = [
      { provider: deadProvider([]), model: "gone", label: "primary" },
      { provider: capturingProvider(answered, "backup"), model: "here", label: "backup" },
    ];

    await run(capturingProvider([]), { events, getModelChain: () => chain });

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ attempt: 0, rung: "primary", model: "gone", answered: false });
    expect(records[1]).toMatchObject({ attempt: 1, rung: "backup", model: "here", answered: true });
    // A failed rung's request is still a request that went out, and it is
    // recorded as faithfully as the one that answered.
    expect(records[1].params).toBe(answered[0]);
  });

  it("records each rung's own request, which is why it cannot be rebuilt from session state", async () => {
    // The `paramsFor` finding, as a test. The head rung gets the full history;
    // a rung with a smaller window gets the history re-trimmed for it. Nothing
    // in the session says which of those was sent.
    const session = newSession(db, "fake-model", "fake");
    for (let i = 0; i < 6; i++) {
      saveMessage(db, session.id, { role: "user", content: `earlier message ${i}` });
      saveMessage(db, session.id, { role: "assistant", content: `earlier reply ${i}` });
    }

    const events = new TypedEventBus();
    const records = collect(events);
    const answered: ChatParams[] = [];
    const chain: ModelCandidate[] = [
      { provider: deadProvider([]), model: "roomy", label: "roomy" },
      // Small enough that the per-rung budget lands at zero and the refit drops
      // everything it can.
      { provider: capturingProvider(answered, "cramped"), model: "cramped", label: "cramped", maxContextTokens: 1 },
    ];

    await runAgentLoop("go", {
      provider: capturingProvider([]),
      session,
      db,
      tools: [],
      extraInstructions: "",
      maxToolRounds: 2,
      maxHistoryTokens: 5000,
      temperature: 0.3,
      events,
      getModelChain: () => chain,
    });

    expect(records).toHaveLength(2);
    expect(records[0].params.messages.length).toBeGreaterThan(records[1].params.messages.length);
    // And the one that answered is the one the provider saw — not the head's.
    expect(records[1].params).toBe(answered[0]);
    expect(records[1].params.messages.length).toBe(answered[0].messages.length);
  });

  it("tells the toolless final report apart from the round whose number it shares", async () => {
    const events = new TypedEventBus();
    const records = collect(events);

    await run(toolLoopingProvider([]), { events, tools: [probe], maxToolRounds: 2 });

    expect(records.map((r) => [r.round, r.phase])).toEqual([
      [1, "round"],
      [2, "round"],
      [2, "final_report"],
    ]);
    // Without `phase` the last two would be indistinguishable except by
    // noticing that one has no tool schemas.
    expect(records[1].params.tools?.length).toBeGreaterThan(0);
    expect(records[2].params.tools ?? []).toHaveLength(0);
  });

  it("counts the history the request was trimmed from", async () => {
    const session = newSession(db, "fake-model", "fake");
    saveMessage(db, session.id, { role: "user", content: "earlier" });
    saveMessage(db, session.id, { role: "assistant", content: "earlier reply" });

    const events = new TypedEventBus();
    const records = collect(events);

    await runAgentLoop("go", {
      provider: capturingProvider([]),
      session,
      db,
      tools: [],
      extraInstructions: "",
      maxToolRounds: 2,
      maxHistoryTokens: 5000,
      temperature: 0.3,
      events,
    });

    // Two seeded plus the message this turn opened with.
    expect(records[0].historyLength).toBe(3);
  });

  it("names the slots that built the system prompt, and what each one cost", async () => {
    registerContextSlot(standing("on-call", "PAGER-DUTY-ROSTER"));
    const events = new TypedEventBus();
    const records = collect(events);

    await run(capturingProvider([]), { events });

    const slot = records[0].slots.find((s) => s.id === "on-call");
    expect(slot).toMatchObject({ id: "on-call", refresh: "reload", truncated: false });
    expect(slot?.chars).toBe("PAGER-DUTY-ROSTER".length);
  });

  it("reports a slot that its own budget cut short", async () => {
    registerContextSlot({ id: "big", refresh: "turn", budgetTokens: 1, render: () => "x".repeat(500) });
    const events = new TypedEventBus();
    const records = collect(events);

    await run(capturingProvider([]), { events });

    expect(records[0].slots.find((s) => s.id === "big")).toMatchObject({ truncated: true });
  });

  it("runs a turn unchanged with no bus at all", async () => {
    const withBus: ChatParams[] = [];
    const withoutBus: ChatParams[] = [];

    await run(capturingProvider(withoutBus));
    await run(capturingProvider(withBus), { events: new TypedEventBus() });

    expect(String(withBus[0].messages[0].content)).toBe(String(withoutBus[0].messages[0].content));
  });

  it("does not let a throwing subscriber fail the turn", async () => {
    const events = new TypedEventBus();
    events.on("agent.request_assembled", () => {
      throw new Error("subscriber exploded");
    });

    await expect(run(capturingProvider([]), { events })).resolves.toBe("ok");
  });
});
