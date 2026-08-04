/**
 * Token accounting used to live in two callers, so the ledger only ever held
 * autopilot and exploratory rows. Everything else the loop runs — chat, room
 * wakes, cron, delegation — recorded nothing, which made "what is this costing
 * me" unanswerable for the majority of a live deployment's traffic.
 *
 * Recording moved into the loop. Two properties matter and are easy to break:
 *
 *  - every provider call writes exactly one row, including when the caller's
 *    own `onUsage` callback throws;
 *  - the autopilot budget stays scoped to autopilot + exploratory. Widening
 *    the table must not widen the budget, or a busy hour in the rooms pauses
 *    autopilot for reasons unrelated to autopilot.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../agent/loop.js";
import { newSession } from "../agent/session.js";
import { getTokenUsageInWindow, recordTokenUsage } from "../db/autopilot-queries.js";
import { initDatabase } from "../db/schema.js";
import type { AIProvider, ChatResponse } from "../providers/interface.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

const provider: AIProvider = {
  id: "fake",
  name: "fake",
  supportsTools: true,
  async chat(): Promise<ChatResponse> {
    return { content: "ok", usage: { input: 120, output: 30 }, finishReason: "stop" };
  },
};

function run(over: Record<string, unknown> = {}) {
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

const rows = () =>
  db.prepare("SELECT agent, source, task_id, prompt_tokens, completion_tokens FROM token_usage").all() as Array<{
    agent: string | null;
    source: string | null;
    task_id: string | null;
    prompt_tokens: number;
    completion_tokens: number;
  }>;

describe("token usage accounting", () => {
  it("records a row for an ordinary loop run, attributed to the agent", async () => {
    await run({ toolContextExtras: { agentName: "researcher" } });

    expect(rows()).toEqual([
      { agent: "researcher", source: "loop", task_id: null, prompt_tokens: 120, completion_tokens: 30 },
    ]);
  });

  it("defaults the source to loop and leaves agent null when unnamed", async () => {
    await run();

    const [row] = rows();
    expect(row.source).toBe("loop");
    expect(row.agent).toBeNull();
  });

  it("labels the row when a caller owns a more specific budget", async () => {
    await run({ usageSource: "autopilot", usageTaskId: "ptask_1", toolContextExtras: { agentName: "coder" } });

    const [row] = rows();
    expect(row.source).toBe("autopilot");
    expect(row.task_id).toBe("ptask_1");
  });

  it("still records when the caller's onUsage callback throws", async () => {
    await run({
      onUsage: () => {
        throw new Error("consumer blew up");
      },
    });

    expect(rows()).toHaveLength(1);
  });

  it("leaves source NULL when a direct caller omits it, so it stays budgeted", () => {
    // Backwards compatibility: an external caller that predates sources must
    // not drop out of the budget just because the column exists now.
    recordTokenUsage(db, { promptTokens: 40, completionTokens: 10 });

    expect(rows()[0].source).toBeNull();
    expect(getTokenUsageInWindow(db, 24, ["autopilot", "exploratory"])).toBe(50);
  });

  it("keeps the autopilot budget scoped to autopilot and exploratory", () => {
    recordTokenUsage(db, { source: "loop", promptTokens: 1000, completionTokens: 0 });
    recordTokenUsage(db, { source: "autopilot", promptTokens: 10, completionTokens: 5 });
    recordTokenUsage(db, { source: "exploratory", promptTokens: 20, completionTokens: 0 });

    // Everything, for "what did this deployment spend".
    expect(getTokenUsageInWindow(db, 24)).toBe(1035);
    // Budgeted scope only — the 1000-token room turn must not trip autopilot.
    expect(getTokenUsageInWindow(db, 24, ["autopilot", "exploratory"])).toBe(35);
  });

  it("counts pre-migration rows, which have a null source, as budgeted", () => {
    // Rows written before `source` existed were all autopilot or exploratory.
    db.prepare("INSERT INTO token_usage (prompt_tokens, completion_tokens, source) VALUES (7, 3, NULL)").run();

    expect(getTokenUsageInWindow(db, 24, ["autopilot", "exploratory"])).toBe(10);
  });
});
