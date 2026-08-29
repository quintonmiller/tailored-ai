/**
 * Correlation across a tool call's events, and the approval path on the bus.
 *
 * Two gaps found comparing TAI's hooks to Claude Code's (#573). Tool events
 * carried a tool *name* and nothing tying them to one another, so two `exec`
 * calls in a turn were indistinguishable and "did the call I approved do what
 * it said" could not be asked. And the approval path ran start to finish
 * without emitting anything, so a deployment could not audit its own
 * approvals — including the ones that never happened.
 *
 * The last part is what the `unattended` case is for. A record covering only
 * the approvals somebody answered would be silent about exactly the calls
 * nobody saw, which is the shape #545 describes.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgentLoop } from "../agent/loop.js";
import { newSession } from "../agent/session.js";
import type { ApprovalHandler, ApprovalRequest, ApprovalResponse } from "../approval.js";
import { initDatabase } from "../db/schema.js";
import type { ApprovalRequested, ApprovalSettled } from "../events.js";
import { TypedEventBus } from "../events.js";
import type { AIProvider, ChatResponse } from "../providers/interface.js";
import type { Tool, ToolResult } from "../tools/interface.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

function probeTool(seen: Array<Record<string, unknown>> = []): Tool {
  return {
    name: "probe",
    description: "records its arguments",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      seen.push(args);
      return { success: true, output: "ran" };
    },
  };
}

/** Asks for `probe` with a known call id, then answers. */
function callsProbe(id = "call-abc"): AIProvider {
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
        toolCalls: [{ id, name: "probe", arguments: { path: "/tmp/a" } }],
        usage: { input: 0, output: 0 },
        finishReason: "tool_calls",
      };
    },
  };
}

function answers(response: Partial<ApprovalResponse>): ApprovalHandler {
  return {
    async requestApproval(_r: ApprovalRequest): Promise<ApprovalResponse> {
      return { approved: true, responseTimeMs: 5, ...response };
    },
  };
}

/** An approver that never answers, so the timeout decides. */
const neverAnswers: ApprovalHandler = {
  requestApproval: () => new Promise<ApprovalResponse>(() => {}),
};

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

/** Collect both approval events in the order they were emitted. */
function collect(events: TypedEventBus) {
  const requested: ApprovalRequested[] = [];
  const settled: ApprovalSettled[] = [];
  events.on("approval.requested", (p) => requested.push(p));
  events.on("approval.settled", (p) => settled.push(p));
  return { requested, settled };
}

/** Approve `probe`, so every test below reaches the gate. */
const permissions = {
  defaultMode: "auto" as const,
  timeoutMs: 300000,
  timeoutAction: "reject" as const,
  tools: { probe: { mode: "approve" as const } },
};
const gated = { permissions };

describe("a tool call can be followed across its own events", () => {
  it("carries the provider's call id on both tool events", async () => {
    const events = new TypedEventBus();
    const pre: string[] = [];
    const post: string[] = [];
    events.onWaterfall("agent.pre_tool_use", (p, next) => {
      pre.push(p.toolUseId);
      return next(p);
    });
    events.on("agent.post_tool_use", (p) => post.push(p.toolUseId));

    await run(callsProbe("call-abc"), [probeTool()], { events });

    // The same id on both is the whole point: this is what lets a subscriber
    // join what was proposed to what actually ran.
    expect(pre).toEqual(["call-abc"]);
    expect(post).toEqual(["call-abc"]);
  });

  it("says where the call runs", async () => {
    const events = new TypedEventBus();
    let cwd: string | undefined;
    events.onWaterfall("agent.pre_tool_use", (p, next) => {
      cwd = p.cwd;
      return next(p);
    });

    await run(callsProbe(), [probeTool()], { events, cwd: "/work/project" });

    expect(cwd).toBe("/work/project");
  });
});

describe("the approval path on the bus", () => {
  it("announces the request before waiting for an answer", async () => {
    const events = new TypedEventBus();
    const { requested } = collect(events);

    await run(callsProbe(), [probeTool()], { events, ...gated, approvalHandler: answers({ approved: true }) });

    expect(requested).toHaveLength(1);
    expect(requested[0]?.tool).toBe("probe");
    expect(requested[0]?.toolUseId).toBe("call-abc");
    // What the approver actually saw, not a reconstruction of it.
    expect(requested[0]?.description).toBeTruthy();
  });

  it("reports an approval, joined to its request", async () => {
    const events = new TypedEventBus();
    const { requested, settled } = collect(events);

    await run(callsProbe(), [probeTool()], { events, ...gated, approvalHandler: answers({ approved: true }) });

    expect(settled).toHaveLength(1);
    expect(settled[0]?.outcome).toBe("approved");
    expect(settled[0]?.timedOut).toBe(false);
    expect(settled[0]?.requestId).toBe(requested[0]?.requestId);
  });

  it("reports a refusal and the reason given", async () => {
    const events = new TypedEventBus();
    const { settled } = collect(events);

    await run(callsProbe(), [probeTool()], {
      events,
      ...gated,
      approvalHandler: answers({ approved: false, reason: "not on a Friday" }),
    });

    expect(settled[0]?.outcome).toBe("rejected");
    expect(settled[0]?.reason).toBe("not on a Friday");
  });

  it("distinguishes an auto-approval on timeout from a considered yes", async () => {
    // The case an auditor most wants to find, and the one that reads exactly
    // like a human approval if the fact is not carried: nobody looked at this.
    const events = new TypedEventBus();
    const { settled } = collect(events);

    await run(callsProbe(), [probeTool()], {
      events,
      permissions: { ...permissions, timeoutMs: 5, timeoutAction: "auto_approve" },
      approvalHandler: neverAnswers,
    });

    expect(settled[0]?.outcome).toBe("approved");
    expect(settled[0]?.timedOut).toBe(true);
  });

  it("marks a rejection on timeout as the clock's answer too", async () => {
    const events = new TypedEventBus();
    const { settled } = collect(events);

    await run(callsProbe(), [probeTool()], {
      events,
      permissions: { ...permissions, timeoutMs: 5 },
      approvalHandler: neverAnswers,
    });

    expect(settled[0]?.outcome).toBe("rejected");
    expect(settled[0]?.timedOut).toBe(true);
  });
});

describe("the approval that never happened", () => {
  it("reports a call that needed a person on a path with none", async () => {
    // No approvalHandler: cron, a room wake, the task watcher. The call still
    // runs under the permissive default — and now says so.
    const events = new TypedEventBus();
    const { requested, settled } = collect(events);
    const executed: Array<Record<string, unknown>> = [];

    await run(callsProbe(), [probeTool(executed)], { events, ...gated });

    expect(requested).toEqual([]);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.outcome).toBe("unattended");
    expect(settled[0]?.requestId).toBeUndefined();
    expect(executed).toHaveLength(1);
  });

  it("reports it the same way when the deployment refuses instead", async () => {
    // Same fact, opposite outcome for the call. The event is about there being
    // nobody to ask, which is true either way.
    const events = new TypedEventBus();
    const { settled } = collect(events);
    const executed: Array<Record<string, unknown>> = [];

    await run(callsProbe(), [probeTool(executed)], {
      events,
      permissions: { ...permissions, noHandlerAction: "reject" },
    });

    expect(settled[0]?.outcome).toBe("unattended");
    expect(executed).toEqual([]);
  });

  it("stays quiet for a call that never needed approval", async () => {
    const events = new TypedEventBus();
    const { requested, settled } = collect(events);

    await run(callsProbe(), [probeTool()], { events });

    expect(requested).toEqual([]);
    expect(settled).toEqual([]);
  });
});
