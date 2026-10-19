/**
 * `agent.turn_started` and `agent.turn_ended`: every turn is bracketed, from
 * the loop itself, so anything showing what an agent is doing can tell when it
 * started thinking and when it stopped — whichever surface ran the turn, and
 * however the turn ended.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentLoopOptions, runAgentLoop } from "../agent/loop.js";
import { newSession } from "../agent/session.js";
import { initDatabase } from "../db/schema.js";
import { TypedEventBus } from "../events.js";
import type { AIProvider, ChatResponse } from "../providers/interface.js";
import type { Tool } from "../tools/interface.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

const probe: Tool = {
  name: "probe",
  description: "does nothing",
  parameters: { type: "object", properties: {} },
  async execute() {
    return { success: true, output: "probed" };
  },
};

/** Calls `probe` once, then answers. */
function oneToolProvider(): AIProvider {
  let called = false;
  return {
    id: "fake",
    name: "fake",
    supportsTools: true,
    async chat(): Promise<ChatResponse> {
      if (called) return { content: "done", usage: { input: 0, output: 0 }, finishReason: "stop" };
      called = true;
      return {
        content: "",
        toolCalls: [{ id: "call-1", name: "probe", arguments: {} }],
        usage: { input: 0, output: 0 },
        finishReason: "tool_calls",
      };
    },
  };
}

function record(events: TypedEventBus): string[] {
  const seen: string[] = [];
  events.on("agent.turn_started", (e) => seen.push(`started ${e.agent}`));
  events.on("agent.post_tool_use", (e) => seen.push(`tool ${e.tool}`));
  events.on("agent.turn_ended", (e) => seen.push(`ended ${e.agent} ${e.stop?.kind ?? "-"} ${e.error ?? ""}`.trim()));
  return seen;
}

function run(provider: AIProvider, events: TypedEventBus, over: Partial<AgentLoopOptions> = {}) {
  return runAgentLoop("go", {
    provider,
    session: newSession(db, "fake-model", "fake"),
    db,
    tools: [probe],
    extraInstructions: "",
    maxToolRounds: 3,
    maxHistoryTokens: 5000,
    temperature: 0.3,
    events,
    toolContextExtras: { agentName: "planner" },
    ...over,
  });
}

describe("turn boundary events", () => {
  it("brackets a turn, its tool calls inside, with why it ended", async () => {
    const events = new TypedEventBus();
    const seen = record(events);
    await run(oneToolProvider(), events);
    expect(seen).toEqual(["started planner", "tool probe", "ended planner complete"]);
  });

  it("still tells the caller why the loop stopped", async () => {
    const events = new TypedEventBus();
    const onStop = vi.fn();
    await run(oneToolProvider(), events, { onStop });
    expect(onStop).toHaveBeenCalledWith({ kind: "complete" });
  });

  it("ends a turn that threw, saying so", async () => {
    const events = new TypedEventBus();
    const seen = record(events);
    const broken: AIProvider = {
      id: "broken",
      name: "broken",
      supportsTools: true,
      async chat(): Promise<ChatResponse> {
        throw new Error("model is down");
      },
    };
    await expect(run(broken, events)).rejects.toThrow();
    expect(seen[0]).toBe("started planner");
    expect(seen.at(-1)).toMatch(/^ended planner - .*model is down/);
  });

  it("carries the session, so two turns of one agent can be told apart", async () => {
    const events = new TypedEventBus();
    const sessions: string[] = [];
    events.on("agent.turn_started", (e) => sessions.push(e.sessionId));
    events.on("agent.turn_ended", (e) => sessions.push(e.sessionId));
    await run(oneToolProvider(), events);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toBe(sessions[1]);
  });
});
