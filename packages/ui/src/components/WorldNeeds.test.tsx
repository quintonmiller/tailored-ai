/**
 * What an agent waits on you for, answered in the world: Approve only for a
 * call the card shows in full, never for a purchase, never by itself; a
 * question on a task answered as the Tasks page answers it; and the list of
 * everything waiting.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingApprovalRequest } from "../api";
import type { Need } from "../lib/needs";
import { whereWords } from "./ChatStage";
import { NeedCard, NeedsList } from "./WorldNeeds";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let fetched: { url: string; method: string; body: unknown }[];
let answer: (url: string, method: string) => { status: number; body: unknown };

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  fetched = [];
  answer = () => ({ status: 200, body: { ok: true } });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      fetched.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const { status, body } = answer(url, method);
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const call = (toolName: string, requestId = "r1"): PendingApprovalRequest => ({
  requestId,
  toolName,
  toolArgs: { target: "staging", branch: "release/2026-10" },
  sessionId: "s1",
  description: `${toolName}(target=staging, branch=release/2026-10)`,
});
const approval = (over: Partial<Need> = {}): Need => ({
  key: "approval:r1",
  agent: "planner",
  kind: "approval",
  what: "waiting for your OK",
  tool: "deploy",
  request: "r1",
  approval: call("deploy"),
  since: new Date(Date.now() - 5 * 60_000).toISOString(),
  ...over,
});

function card(needs: Need[], over: Partial<Parameters<typeof NeedCard>[0]> = {}) {
  const props = {
    agent: "planner",
    needs,
    loading: false,
    failed: false,
    onOpenTask: vi.fn(),
    onAnswered: vi.fn(),
    onReply: vi.fn(),
    inChat: () => false,
    onShowChat: vi.fn(),
    onAbout: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  act(() => root.render(<NeedCard {...props} />));
  return props;
}
const buttons = () => [...container.querySelectorAll("button")].map((b) => b.textContent?.trim());
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
const settle = () => act(async () => {});
function type(el: HTMLTextAreaElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    set?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("an approval, in the world", () => {
  it("shows the call in full, and approves it with your note on an explicit click", async () => {
    card([approval()]);
    expect(container.textContent).toContain("deploy(target=staging, branch=release/2026-10)");
    expect(container.textContent).toContain("release/2026-10");
    // Nothing is focused for you: a key pressed now approves nothing.
    expect(document.activeElement).not.toBe(button("Approve"));
    type(container.querySelector("textarea") as HTMLTextAreaElement, "Staging only.");
    await act(async () => button("Approve").click());
    await settle();
    expect(fetched.at(-1)).toEqual({
      url: "/api/approvals/r1",
      method: "POST",
      body: { approved: true, reason: "Staging only." },
    });
    expect(container.textContent).toContain("Approved. planner carries on.");
    expect(buttons()).not.toContain("Approve");
  });

  it("approves nothing on the second click of a double click: one aimed at the list row this card replaced", async () => {
    card([approval()]);
    const approve = button("Approve");
    await act(async () => {
      approve.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
      approve.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 3 }));
    });
    await settle();
    expect(fetched.filter((f) => f.method === "POST")).toEqual([]);
    // A click of its own approves.
    await act(async () => approve.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    await settle();
    expect(fetched.filter((f) => f.method === "POST").map((f) => f.body)).toEqual([{ approved: true }]);
  });

  it("denies, and says so", async () => {
    card([approval()]);
    await act(async () => button("Deny").click());
    await settle();
    expect(fetched.at(-1)?.body).toEqual({ approved: false });
    expect(container.textContent).toContain("Denied. planner has been told.");
  });

  it("says when it was answered somewhere else first", async () => {
    answer = () => ({ status: 404, body: { error: "No pending approval" } });
    card([approval()]);
    await act(async () => button("Approve").click());
    await settle();
    expect(container.textContent).toContain("Already answered somewhere else.");
  });

  it("offers no Approve for a purchase: its details, where it is approved, and Deny", async () => {
    card([approval({ tool: "purchase_item", approval: call("purchase_item") })]);
    expect(container.textContent).toContain("purchase_item(target=staging");
    expect(buttons()).not.toContain("Approve");
    expect(container.textContent).toContain("approved in the chat that asked for it");
    expect(container.textContent).toContain("open in another tab or on another device");
    // Nothing on this page holds it to show.
    expect(buttons()).not.toContain("Show the chat");
    await act(async () => button("Deny").click());
    await settle();
    expect(fetched.at(-1)).toEqual({ url: "/api/approvals/r1", method: "POST", body: { approved: false } });
  });

  it("shows the chat holding a purchase's request, when it is the one on this page", () => {
    const props = card([approval({ tool: "buyTickets", approval: call("buyTickets") })], {
      inChat: (r: string) => r === "r1",
    });
    expect(buttons()).not.toContain("Approve");
    expect(container.textContent).toContain("the chat on this page");
    act(() => button("Show the chat").click());
    expect(props.onShowChat).toHaveBeenCalled();
  });

  it("offers no Approve without the details: still coming, or asked where the world can't answer", () => {
    card([approval({ approval: undefined })], { loading: true });
    expect(container.textContent).toContain("Getting the details");
    expect(buttons()).not.toContain("Approve");
    card([approval({ approval: undefined })]);
    expect(container.textContent).toContain("like Discord");
    expect(buttons()).not.toContain("Approve");
  });

  it("keeps saying what happened after the agent stops waiting, and what stopped without you", () => {
    card([approval(), approval({ key: "approval:r2", request: "r2", approval: call("deploy", "r2") })]);
    card([approval()]);
    expect(container.textContent).toContain("Answered somewhere else, or it stopped waiting.");
    expect(buttons().filter((b) => b === "Approve")).toHaveLength(1);
  });
});

describe("a question on a task, in the world", () => {
  const task = {
    id: "ptask_1",
    title: "Review the newsletter",
    description: "",
    status: "blocked",
    blocked_reason: "question",
    author: "sam",
    tags: [],
    project_id: null,
    assignee: "reviewer",
    rank: 0,
    created_at: "2026-10-19 08:00:00",
    updated_at: "2026-10-19 09:00:00",
    comments: [
      {
        id: 1,
        task_id: "ptask_1",
        author: "reviewer",
        content: "**Question for user:** New link or none?",
        created_at: "x",
      },
    ],
  };

  it("shows the question as asked, and answers it as the Tasks page does", async () => {
    answer = (url, method) =>
      method === "GET"
        ? { status: 200, body: task }
        : url.endsWith("/comments")
          ? { status: 201, body: { id: 2 } }
          : { status: 200, body: { ...task, status: "backlog", blocked_reason: null } };
    const props = card(
      [{ key: "task:ptask_1", agent: "reviewer", kind: "question", what: "has a question for you", task: "ptask_1" }],
      { agent: "reviewer" },
    );
    await settle();
    expect(container.textContent).toContain("New link or none?");
    type(container.querySelector("textarea") as HTMLTextAreaElement, "The new one.");
    await act(async () => button("Send answer").click());
    await settle();
    expect(fetched.filter((f) => f.method !== "GET").map((f) => [f.method, f.url, f.body])).toEqual([
      ["POST", "/api/project-tasks/ptask_1/comments", { author: "user", content: "The new one." }],
      ["PATCH", "/api/project-tasks/ptask_1", { status: "backlog", blocked_reason: null }],
    ]);
    expect(props.onAnswered).toHaveBeenCalledWith(expect.objectContaining({ status: "backlog" }));
    expect(container.textContent).toContain("back in the backlog for reviewer");
  });
});

describe("a question asked in a chat", () => {
  it("is answered in the conversation it was asked in, the question quoted", () => {
    const props = card(
      [
        {
          key: "ask:assistant",
          agent: "assistant",
          kind: "question",
          what: "has a question for you",
          detail: "Saturday…",
          question: "Saturday or Monday?",
          session: "s-asked",
        },
      ],
      { agent: "assistant" },
    );
    act(() => button("Answer in the chat").click());
    expect(props.onReply).toHaveBeenCalledWith("About your question, “Saturday or Monday?”: ", "s-asked");
  });
});

describe("the list of what needs you", () => {
  it("has a row per request, and a row takes you to it", () => {
    const onOpen = vi.fn();
    const needs = [approval(), { ...approval({ agent: "writer", key: "approval:r2" }), tool: "purchase_item" }];
    act(() =>
      root.render(
        <NeedsList
          needs={needs}
          whereOf={(a) => (a === "planner" ? "at home" : undefined)}
          onOpen={onOpen}
          onClose={vi.fn()}
        />,
      ),
    );
    const rows = [...container.querySelectorAll(".world-needs-row")] as HTMLButtonElement[];
    expect(rows.map((r) => r.textContent)).toEqual([
      "!plannerwaiting 5 minwants your OK to use deployat home",
      "!writerwaiting 5 minwants your OK to use purchase_item",
    ]);
    act(() => rows[1].click());
    expect(onOpen).toHaveBeenCalledWith(needs[1]);
  });
});

describe("whereWords", () => {
  const places = [
    { id: "home:planner", name: "planner's home", kind: "home", owner: "planner", agents: ["planner"] },
    { id: "room:local:trip", name: "trip", kind: "room", agents: ["writer"] },
    { id: "shared:lounge", name: "the lounge", kind: "shared", agents: ["reviewer"] },
  ] as Parameters<typeof whereWords>[1];

  it("says where a body is, from where you stand", () => {
    expect(whereWords("planner", places, "shared:lounge")).toBe("at home");
    expect(whereWords("writer", places, undefined)).toBe("in #trip");
    expect(whereWords("reviewer", places, "shared:lounge")).toBe("here");
    expect(whereWords("nobody", places, undefined)).toBeUndefined();
  });
});
