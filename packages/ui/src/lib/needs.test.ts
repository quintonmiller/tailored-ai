/**
 * What is waiting on you: which requests belong to which agent, in what
 * order, when a question has been answered, and which approvals the world
 * may never offer to approve.
 */
import { describe, expect, it } from "vitest";
import type { PendingApprovalRequest } from "../api";
import type { AgentActivity } from "../avatar/doing";
import {
  answerable,
  byWait,
  type Need,
  type NeedTask,
  needsFrom,
  ownFlow,
  questionIn,
  requestsOf,
  withQuestions,
} from "./needs";

const waiting = (agent: string, extra: Partial<AgentActivity> = {}): AgentActivity => ({
  agent,
  doing: "waiting",
  what: extra.request ? "waiting for your OK" : "has a question for you",
  ...extra,
});
const idle = (agent: string): AgentActivity => ({ agent, doing: "idle", what: "idle" });
const task = (id: string, over: Partial<NeedTask> = {}): NeedTask => ({
  id,
  title: `Task ${id}`,
  status: "blocked",
  assignee: "writer",
  blocked_reason: "question",
  updated_at: "2026-10-19T08:00:00Z",
  ...over,
});
const approval = (requestId: string, toolName = "exec"): PendingApprovalRequest => ({
  requestId,
  toolName,
  toolArgs: { command: "ls" },
  sessionId: "s1",
  description: `${toolName}: ls`,
});

describe("needsFrom", () => {
  it("gives each waiting agent's request its own row, with the approval's details when the server has them", () => {
    const needs = needsFrom(
      {
        planner: waiting("planner", { request: "r1", tool: "exec", since: "2026-10-19T09:00:00Z" }),
        writer: waiting("writer", {
          task: "t1",
          detail: "Which tone?",
          question: "Which tone? Warm or formal?",
          since: "2026-10-19T08:30:00Z",
        }),
        reviewer: waiting("reviewer", { detail: "Ship it?", since: "2026-10-19T08:00:00Z" }),
        assistant: idle("assistant"),
      },
      [approval("r1"), approval("r9")],
      [],
    );
    expect(needs.map((n) => [n.key, n.agent, n.kind])).toEqual([
      ["approval:r1", "planner", "approval"],
      ["ask:reviewer", "reviewer", "question"],
      ["task:t1", "writer", "question"],
    ]);
    expect(needs[0]?.approval?.requestId).toBe("r1");
    expect(needs[2]).toMatchObject({ task: "t1", detail: "Which tone?", question: "Which tone? Warm or formal?" });
  });

  it("leaves an approval it can't answer here without details: asked on Discord, say", () => {
    const [need] = needsFrom({ planner: waiting("planner", { request: "r2", tool: "exec" }) }, [approval("r1")], []);
    expect(need?.request).toBe("r2");
    expect(need?.approval).toBeUndefined();
  });

  it("adds tasks blocked on a question for you, once each, and none that aren't", () => {
    const needs = needsFrom(
      { writer: waiting("writer", { task: "t1" }) },
      [],
      [
        task("t1"),
        task("t2", { assignee: "planner", updated_at: "2026-10-19T07:00:00Z" }),
        task("t3", { blocked_reason: "budget" }),
        task("t4", { status: "in_progress", blocked_reason: null }),
        task("t5", { assignee: null }),
      ],
    );
    expect(needs.map((n) => n.key)).toEqual(["task:t2", "task:t1"]);
    expect(needs[0]).toMatchObject({ agent: "planner", detail: "Task t2", since: "2026-10-19T07:00:00Z" });
  });

  it("ranks several agents at once: approvals first, then whoever has waited longest", () => {
    const needs = needsFrom(
      {
        a: waiting("a", { since: "2026-10-19T08:00:00Z" }),
        b: waiting("b", { request: "rb", since: "2026-10-19T09:00:00Z" }),
        c: waiting("c", { request: "rc", since: "2026-10-19T08:30:00Z" }),
        d: waiting("d"),
        e: waiting("e", { since: "2026-10-19T07:00:00Z" }),
      },
      [],
      [],
    );
    expect(needs.map((n) => n.agent)).toEqual(["c", "b", "e", "a", "d"]);
  });
});

describe("withQuestions", () => {
  it("stops an agent waiting on a task once the task has moved on", () => {
    const shown = withQuestions({ writer: waiting("writer", { task: "t1", since: "x" }) }, [
      task("t1", { status: "in_progress", blocked_reason: null }),
    ]);
    expect(shown.writer).toEqual({ agent: "writer", doing: "idle", what: "idle", since: "x" });
  });

  it("keeps it waiting while the task is still blocked, or isn't on the boards to say", () => {
    const now = { writer: waiting("writer", { task: "t1" }), planner: waiting("planner", { task: "t9" }) };
    expect(withQuestions(now, [task("t1")])).toBe(now);
  });

  it("shows an idle agent with a task blocked on a question as waiting on you, but leaves the busy and asleep be", () => {
    const shown = withQuestions(
      {
        writer: idle("writer"),
        planner: { agent: "planner", doing: "working", what: "searching" },
        reviewer: { agent: "reviewer", doing: "asleep", what: "asleep" },
      },
      [
        task("t1", { updated_at: "2026-10-19T08:00:00Z" }),
        task("t0", { title: "Older" }),
        task("t2", { assignee: "planner" }),
        task("t3", { assignee: "reviewer" }),
        task("t4", { assignee: "assistant" }),
      ],
    );
    expect(shown.writer).toMatchObject({
      doing: "waiting",
      task: "t1",
      detail: "Task t1",
      since: "2026-10-19T08:00:00Z",
    });
    expect(shown.planner?.doing).toBe("working");
    expect(shown.reviewer?.doing).toBe("asleep");
    // An agent with no activity yet still waits on you.
    expect(shown.assistant).toMatchObject({ doing: "waiting", task: "t4" });
  });

  it("is the same object when nothing changes, so the stage isn't told twice", () => {
    const now = { writer: idle("writer") };
    expect(withQuestions(now, [task("t1", { status: "done", blocked_reason: null })])).toBe(now);
  });
});

describe("byWait", () => {
  it("puts an approval first, then the longer wait, and a wait of unknown length last", () => {
    const list = [
      { id: "q-late", since: "2026-10-19T09:00:00Z" },
      { id: "q-unknown" },
      { id: "a-late", request: "r", since: "2026-10-19T09:30:00Z" },
      { id: "q-early", since: "2026-10-19T08:00:00Z" },
    ];
    expect(list.sort(byWait).map((x) => x.id)).toEqual(["a-late", "q-early", "q-late", "q-unknown"]);
  });
});

describe("ownFlow", () => {
  it("knows the trusted-actions tools and anything named for spending money", () => {
    for (const tool of ["purchase_item", "request_action", "request_read", "buy_tickets", "pay-invoice", "Checkout"])
      expect(ownFlow(tool)).toBe(true);
  });

  it("leaves ordinary tools to the world", () => {
    for (const tool of ["exec", "write_file", "web_search", "payload_check", "reorder", undefined])
      expect(ownFlow(tool)).toBe(false);
  });
});

describe("answerable", () => {
  const need = (over: Partial<Need> = {}): Need => ({
    key: "approval:r1",
    agent: "planner",
    kind: "approval",
    what: "waiting for your OK",
    tool: "exec",
    request: "r1",
    approval: approval("r1"),
    ...over,
  });

  it("offers Approve for an approval the server lists, for the very request the agent waits on", () => {
    expect(answerable(need())).toBe(true);
  });

  it("never offers it without the details, for another request, for a question, or for a stricter flow", () => {
    expect(answerable(need({ approval: undefined }))).toBe(false);
    expect(answerable(need({ approval: approval("r2") }))).toBe(false);
    expect(answerable(need({ kind: "question" }))).toBe(false);
    expect(answerable(need({ tool: "purchase_item", approval: approval("r1", "purchase_item") }))).toBe(false);
    // What the server says the call is wins over what the activity said.
    expect(answerable(need({ tool: "exec", approval: approval("r1", "purchase_item") }))).toBe(false);
  });
});

describe("questionIn", () => {
  it("is the latest question asked on the task, without its heading", () => {
    const comments = [
      { content: "**Question for user:** Old question?" },
      { content: "Working on it." },
      { content: "**Question for user:** Window or aisle?" },
      { content: "Note from the reviewer" },
    ];
    expect(questionIn(comments)).toBe("Window or aisle?");
  });

  it("falls back to what the agent said when no comment asks", () => {
    expect(questionIn([{ content: "Errored" }], "Which tone?")).toBe("Which tone?");
    expect(questionIn([])).toBeUndefined();
  });
});

describe("requestsOf", () => {
  it("is the approvals agents wait on, the same however they are ordered", () => {
    const a = { x: waiting("x", { request: "r2" }), y: waiting("y", { request: "r1" }), z: waiting("z") };
    const b = { y: waiting("y", { request: "r1" }), x: waiting("x", { request: "r2" }) };
    expect(requestsOf(a)).toBe("r1,r2");
    expect(requestsOf(b)).toBe(requestsOf(a));
  });
});
