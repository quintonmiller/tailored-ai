/**
 * Tool-level dispatch: `agent.pre_tool_use` and `agent.post_tool_use`.
 *
 * The loop had no tool-level seam at all. `executeToolCall` ran an ordered gate
 * chain — skill allowlist, validation, approval, derivability, execute — and
 * nothing extensible attached to any of it, which is why three separate issues
 * were blocked on the same absence: an approval stage that any tool can use
 * (#545), a hook dialect with `PreToolUse` to bridge (#544), and a workflow
 * trigger that fires on a tool call (#561).
 *
 * The placement is the part worth pinning. `pre_tool_use` runs before the
 * approval gate so a rewrite reaches the human who approves it, and before
 * validation so whatever actually executes is what got validated.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../agent/loop.js";
import { newSession } from "../agent/session.js";
import type { ApprovalHandler, ApprovalRequest } from "../approval.js";
import { initDatabase } from "../db/schema.js";
import { TypedEventBus } from "../events.js";
import type { AIProvider, ChatResponse } from "../providers/interface.js";
import type { Tool, ToolContext, ToolResult } from "../tools/interface.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

/** Records every call it receives, so a rewrite is observable. */
function probeTool(seen: Array<Record<string, unknown>>, result: Partial<ToolResult> = {}): Tool {
  return {
    name: "probe",
    description: "records its arguments",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      seen.push(args);
      return { success: true, output: "ran", ...result };
    },
  };
}

/** Asks for `probe` once, then answers. */
function callsProbe(args: Record<string, unknown> = { path: "/tmp/a" }): AIProvider {
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
        toolCalls: [{ id: "c1", name: "probe", arguments: args }],
        usage: { input: 0, output: 0 },
        finishReason: "tool_calls",
      };
    },
  };
}

function run(provider: AIProvider, tools: Tool[], over: Record<string, unknown> = {}) {
  return runAgentLoop("go", {
    provider,
    session: newSession(db, "fake-model", "fake"),
    db,
    tools,
    extraInstructions: "",
    maxToolRounds: 3,
    maxHistoryTokens: 5000,
    temperature: 0.3,
    ...over,
  });
}

describe("agent.pre_tool_use", () => {
  it("sees the call before it runs", async () => {
    const events = new TypedEventBus();
    const seen: Array<{ tool: string; args: Record<string, unknown> }> = [];
    events.onWaterfall("agent.pre_tool_use", (p, next) => {
      seen.push({ tool: p.tool, args: p.args });
      return next(p);
    });

    await run(callsProbe(), [probeTool([])], { events });

    expect(seen).toEqual([{ tool: "probe", args: { path: "/tmp/a" } }]);
  });

  it("lets a subscriber refuse, and the tool never runs", async () => {
    const events = new TypedEventBus();
    events.onWaterfall("agent.pre_tool_use", (p, next) => next({ ...p, deny: "Refused: /tmp is off limits." }));
    const executed: Array<Record<string, unknown>> = [];

    await run(callsProbe(), [probeTool(executed)], { events });

    expect(executed).toEqual([]);
  });

  it("returns the refusal to the model as the tool's result", async () => {
    // "Denied" alone tells a model nothing. The text is what it reads next, so
    // it has to say what to do instead.
    const events = new TypedEventBus();
    events.onWaterfall("agent.pre_tool_use", (p, next) => next({ ...p, deny: "Refused: use /work instead." }));
    const results: string[] = [];

    await run(callsProbe(), [probeTool([])], {
      events,
      onToolResult: (_name: string, out: string) => results.push(out),
    });

    expect(results).toEqual(["Refused: use /work instead."]);
  });

  it("lets a subscriber rewrite the arguments", async () => {
    // The difference between a guard that says no and one that says "not like
    // that".
    const events = new TypedEventBus();
    events.onWaterfall("agent.pre_tool_use", (p, next) => next({ ...p, args: { path: "/work/safe" } }));
    const executed: Array<Record<string, unknown>> = [];

    await run(callsProbe({ path: "/etc/passwd" }), [probeTool(executed)], { events });

    expect(executed).toEqual([{ path: "/work/safe" }]);
  });

  it("validates the rewrite, not just the original", async () => {
    // A subscriber is not more trusted than the model. Running before
    // validation is what makes this hold.
    const events = new TypedEventBus();
    events.onWaterfall("agent.pre_tool_use", (p, next) => next({ ...p, args: { wrong: 1 } }));
    const executed: Array<Record<string, unknown>> = [];
    const results: string[] = [];

    await run(callsProbe(), [probeTool(executed)], {
      events,
      onToolResult: (_n: string, out: string) => results.push(out),
    });

    expect(executed).toEqual([]);
    expect(results[0]).toContain("Error:");
  });

  it("shows the human the call that will actually run", async () => {
    // The ordering that matters most: a rewrite after approval would mean the
    // owner approves one command and a different one executes.
    const events = new TypedEventBus();
    events.onWaterfall("agent.pre_tool_use", (p, next) => next({ ...p, args: { path: "/work/safe" } }));

    const asked: ApprovalRequest[] = [];
    const approvalHandler: ApprovalHandler = {
      async requestApproval(request: ApprovalRequest) {
        asked.push(request);
        return { requestId: request.requestId, approved: true, responseTimeMs: 1 };
      },
    };

    await run(callsProbe({ path: "/etc/passwd" }), [probeTool([])], {
      events,
      approvalHandler,
      permissions: { tools: { probe: { mode: "approve" } } },
    });

    expect(asked).toHaveLength(1);
    expect(asked[0].toolArgs).toEqual({ path: "/work/safe" });
  });

  it("changes nothing when a bus has no subscribers", async () => {
    const executed: Array<Record<string, unknown>> = [];
    await run(callsProbe(), [probeTool(executed)], { events: new TypedEventBus() });
    expect(executed).toEqual([{ path: "/tmp/a" }]);
  });

  it("runs a turn unchanged with no bus at all", async () => {
    const executed: Array<Record<string, unknown>> = [];
    await run(callsProbe(), [probeTool(executed)]);
    expect(executed).toEqual([{ path: "/tmp/a" }]);
  });
});

describe("agent.post_tool_use", () => {
  it("reports the call that ran", async () => {
    const events = new TypedEventBus();
    const used: Array<Record<string, unknown>> = [];
    events.on("agent.post_tool_use", (e) => used.push({ ...e }));

    await run(callsProbe(), [probeTool([])], { events });

    expect(used).toHaveLength(1);
    expect(used[0]).toMatchObject({ tool: "probe", args: { path: "/tmp/a" }, success: true });
    expect(String(used[0].output)).toContain("ran");
    expect(typeof used[0].durationMs).toBe("number");
  });

  it("reports the rewritten arguments, not the model's", async () => {
    const events = new TypedEventBus();
    events.onWaterfall("agent.pre_tool_use", (p, next) => next({ ...p, args: { path: "/work/safe" } }));
    const used: Array<Record<string, unknown>> = [];
    events.on("agent.post_tool_use", (e) => used.push({ ...e }));

    await run(callsProbe({ path: "/etc/passwd" }), [probeTool([])], { events });

    expect(used[0].args).toEqual({ path: "/work/safe" });
  });

  it("does not fire for a call that was refused", async () => {
    // What makes this countable: executions, not intentions.
    const events = new TypedEventBus();
    events.onWaterfall("agent.pre_tool_use", (p, next) => next({ ...p, deny: "no" }));
    const used: unknown[] = [];
    events.on("agent.post_tool_use", (e) => used.push(e));

    await run(callsProbe(), [probeTool([])], { events });

    expect(used).toEqual([]);
  });

  it("fires for a tool that failed, because it still ran", async () => {
    const events = new TypedEventBus();
    const used: Array<Record<string, unknown>> = [];
    events.on("agent.post_tool_use", (e) => used.push({ ...e }));
    const failing = probeTool([], { success: false, error: "nope" });

    await run(callsProbe(), [failing], { events });

    expect(used).toHaveLength(1);
    expect(used[0].success).toBe(false);
  });
});
