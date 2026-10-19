/**
 * The activity plugin: one record per agent saying what it is doing, kept from
 * the bus alone. The tests drive the events a real turn emits and read the
 * records back the way the page does, through the state service.
 */
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoopStop } from "../agent/loop.js";
import { TypedEventBus } from "../events.js";
import plugin, {
  ACTIVITY_SCHEMA,
  ACTIVITY_TYPE,
  type Activity,
  ActivityTracker,
  nextWake,
  SPEECH_SCHEMA,
  SPEECH_TYPE,
  type Speech,
  whyAsleep,
} from "../plugins/activity.js";
import "../state/builtin.js";
import { type StateCaller, StateService } from "../state/service.js";
import { StateError } from "../state/types.js";

const PERSON: StateCaller = { actor: { kind: "user", name: "owner" } };

let events: TypedEventBus;
let state: StateService;
let sleeping: Map<string, string>;
let tracker: ActivityTracker;

function make(over: Partial<ConstructorParameters<typeof ActivityTracker>[0]> = {}) {
  tracker = new ActivityTracker({
    events,
    state: () => state,
    agents: () => ["default", "planner", "writer"],
    asleep: (agent) => sleeping.get(agent) ?? null,
    settleMs: 0,
    ...over,
  });
  return tracker;
}

beforeEach(() => {
  events = new TypedEventBus();
  sleeping = new Map();
  state = new StateService({
    getConfig: () => ({
      state: {
        backend: "sqlite",
        types: [
          {
            name: ACTIVITY_TYPE,
            scope: "global",
            provider: "memory",
            schema: ACTIVITY_SCHEMA as never,
            access: { write: [] },
          },
          {
            name: SPEECH_TYPE,
            scope: "global",
            provider: "memory",
            schema: SPEECH_SCHEMA as never,
            access: { read: ["user"], write: [] },
          },
        ],
      },
    }),
    db: new Database(":memory:"),
  });
});

afterEach(() => {
  tracker?.stop();
  vi.useRealTimers();
});

async function activity(agent: string): Promise<Activity> {
  await tracker.settled();
  const record = await state.get(PERSON, { type: ACTIVITY_TYPE, id: agent });
  return record?.data as unknown as Activity;
}

async function doing(agent: string): Promise<string> {
  const a = await activity(agent);
  return [a.doing, a.what, a.detail, a.look, a.with].filter(Boolean).join(" | ");
}

const turn = (agent: string | undefined, sessionId = `s-${agent}`) => ({ sessionId, agent, projectId: null });

function started(agent: string | undefined, sessionId?: string) {
  events.emit("agent.turn_started", turn(agent, sessionId));
}

function ended(agent: string | undefined, extra: { stop?: LoopStop; error?: string } = {}, sessionId?: string) {
  events.emit("agent.turn_ended", { ...turn(agent, sessionId), ...extra });
}

function roomEnded(agent: string, posted: boolean, rooms = ["local:trip"]) {
  events.emit("room.turn_ended", { rooms, agent, stallReason: null, posted });
}

let toolIds = 0;
async function tool(agent: string, name: string, args: Record<string, unknown> = {}, finish = true) {
  const toolUseId = `t${++toolIds}`;
  const base = { sessionId: `s-${agent}`, agent, projectId: null, tool: name, toolUseId, cwd: "/", args };
  await events.waterfall("agent.pre_tool_use", base);
  if (finish) events.emit("agent.post_tool_use", { ...base, output: "", success: true, durationMs: 1 });
  return base;
}

describe("activity", () => {
  it("starts every agent idle, or asleep when a switch says so", async () => {
    sleeping.set("writer", "paused");
    await make().start();
    expect(await doing("planner")).toBe("idle | idle");
    expect(await doing("writer")).toBe("asleep | asleep | paused");
    expect(await doing("default")).toBe("idle | idle");
  });

  it("follows a turn: thinking, working with a tool, thinking again, idle", async () => {
    make();
    started("planner");
    expect(await doing("planner")).toBe("thinking | thinking");
    const call = await tool("planner", "web_search", { query: "flights to Lisbon in May" }, false);
    expect(await doing("planner")).toBe("working | searching the web | flights to Lisbon in May | magnifier");
    events.emit("agent.post_tool_use", { ...call, output: "", success: true, durationMs: 1 });
    expect(await doing("planner")).toBe("thinking | thinking");
    ended("planner", { stop: { kind: "complete" } });
    expect(await doing("planner")).toBe("idle | idle");
  });

  it("gives a turn without a name to the default agent", async () => {
    make();
    started(undefined);
    expect(await doing("default")).toBe("thinking | thinking");
  });

  it("says what a tool looks like, from its arguments where they matter", async () => {
    make();
    started("planner");
    await tool("planner", "place", { action: "photo", view: "selfie" }, false);
    expect(await doing("planner")).toBe("working | taking a selfie | camera");
    await tool("planner", "mystery_tool", {}, false);
    expect(await doing("planner")).toBe("working | using mystery_tool");
  });

  it("lets a deployment say how its own tools look, by tool or tool.action", async () => {
    make({
      tools: { flights: { what: "looking up flights", look: "tablet" }, "place.photo": { what: "snapping" } },
    });
    started("planner");
    await tool("planner", "flights", {}, false);
    expect(await doing("planner")).toBe("working | looking up flights | tablet");
    await tool("planner", "place", { action: "photo" }, false);
    expect(await doing("planner")).toBe("working | snapping | camera");
  });

  it("does not show a call that was refused", async () => {
    make();
    events.onWaterfall("agent.pre_tool_use", async (p, next) => next({ ...p, deny: "not now" }));
    started("planner");
    await tool("planner", "exec", { command: "ls" }, false);
    expect(await doing("planner")).toBe("thinking | thinking");
  });

  it("shows both ends of a direct message as talking to each other", async () => {
    make();
    started("planner");
    await tool("planner", "room", { action: "dm", agent: "writer", body: "draft the intro?" }, false);
    expect(await doing("planner")).toBe("talking | talking to writer | writer");
    started("writer");
    expect(await doing("writer")).toBe("talking | talking to planner | planner");
    ended("writer", { stop: { kind: "complete" } });
    expect(await doing("writer")).toBe("idle | idle");
  });

  it("waits on you after asking something, until its next turn", async () => {
    make();
    started("planner");
    await tool("planner", "ask_user", { question: "Window or aisle?" });
    ended("planner", { stop: { kind: "complete" } });
    expect(await doing("planner")).toBe("waiting | has a question for you | Window or aisle?");
    started("planner");
    expect(await doing("planner")).toBe("thinking | thinking");
    ended("planner", { stop: { kind: "complete" } });
    expect(await doing("planner")).toBe("idle | idle");
  });

  it("waits on you after sending a choice, but not after sending a card", async () => {
    make();
    started("planner");
    await tool("planner", "interface", { action: "send", kind: "card", props: { title: "Itinerary" } });
    ended("planner", { stop: { kind: "complete" } });
    expect(await doing("planner")).toBe("idle | idle");
    started("planner");
    await tool("planner", "interface", { action: "send", kind: "choice", props: { question: "Which hotel?" } });
    ended("planner", { stop: { kind: "complete" } });
    expect(await doing("planner")).toBe("waiting | has a question for you | Which hotel?");
  });

  it("waits while a person is asked to approve a call", async () => {
    make();
    started("planner");
    const approval = { sessionId: "s-planner", agent: "planner", projectId: null, tool: "exec", toolUseId: "x" };
    events.emit("approval.requested", { ...approval, requestId: "r", description: "rm" });
    expect(await doing("planner")).toBe("waiting | waiting for your OK");
    events.emit("approval.settled", { ...approval, requestId: "r", outcome: "approved", timedOut: false } as never);
    expect(await doing("planner")).toBe("thinking | thinking");
  });

  it("says which approval it waits on, and stops only when that one is answered", async () => {
    make();
    started("planner");
    const approval = { sessionId: "s-planner", agent: "planner", projectId: null, tool: "exec", toolUseId: "x" };
    events.emit("approval.requested", { ...approval, requestId: "r1", description: "rm" });
    expect(await activity("planner")).toMatchObject({ doing: "waiting", tool: "exec", request: "r1" });
    // A call on a path with nobody to ask, or another request's answer, isn't this one's.
    events.emit("approval.settled", { ...approval, outcome: "unattended", timedOut: false } as never);
    events.emit("approval.settled", { ...approval, requestId: "r0", outcome: "approved", timedOut: false } as never);
    expect(await activity("planner")).toMatchObject({ doing: "waiting", request: "r1" });
    events.emit("approval.settled", { ...approval, requestId: "r1", outcome: "rejected", timedOut: false } as never);
    const after = await activity("planner");
    expect(after.doing).toBe("thinking");
    expect(after.request).toBeUndefined();
  });

  it("needs you when a task does, and says which task", async () => {
    make();
    events.emit("task.needs_human", { taskId: "t", agentName: "writer", reason: "question", message: "Which tone?" });
    expect(await doing("writer")).toBe("waiting | needs you | Which tone?");
    expect((await activity("writer")).task).toBe("t");
  });

  it("keeps a long question whole for a page to answer from, and its status line short", async () => {
    make();
    const question = `Which of these hotels?\n${"The one by the river, or the one up the hill. ".repeat(4)}`;
    started("planner");
    await tool("planner", "ask_user", { question });
    ended("planner", { stop: { kind: "complete" } });
    const a = await activity("planner");
    expect(a.question).toBe(question.trim());
    expect(a.detail?.length).toBeLessThan(question.length);
  });

  it("ties a question asked from a task run to the task", async () => {
    make();
    started("planner");
    await tool("planner", "ask_user", { question: "Window or aisle?" }, false);
    events.emit("question.asked", { question: "Window or aisle?", sessionId: "s-planner", taskId: "ptask_1" });
    ended("planner", { stop: { kind: "complete" } });
    expect(await activity("planner")).toMatchObject({
      doing: "waiting",
      what: "has a question for you",
      detail: "Window or aisle?",
      task: "ptask_1",
    });
  });

  it("stops waiting once the task it asked about leaves blocked, wherever it was answered", async () => {
    make();
    events.emit("task.needs_human", { taskId: "t1", agentName: "writer", reason: "question", message: "Which tone?" });
    // Another task moving, or this one staying blocked, changes nothing.
    events.emit("task.transitioned", { taskId: "t2", from: "blocked", to: "backlog" });
    events.emit("task.transitioned", { taskId: "t1", from: "in_progress", to: "blocked" });
    expect((await activity("writer")).doing).toBe("waiting");
    events.emit("task.transitioned", { taskId: "t1", from: "blocked", to: "backlog" });
    const after = await activity("writer");
    expect(after.doing).toBe("idle");
    expect(after.task).toBeUndefined();
  });

  it("keeps waiting on a task that needs you without being blocked, whichever plugin hears its move first", async () => {
    // As the verify gate does: a task reaching done with no verification is left done, for a person to check,
    // and the escalation goes out from inside the move to done. Subscribed before the tracker, as it is in a
    // deployment that had the gate before it had the tracker, the gate's escalation lands before the tracker
    // hears the move that set it off.
    events.on("task.transitioned", (e) => {
      if (e.to !== "done") return;
      events.emit("task.needs_human", {
        taskId: e.taskId,
        agentName: "writer",
        reason: "verify",
        message: `Task ${e.taskId} reached done without a recorded verification.`,
      });
    });
    make();
    events.emit("task.transitioned", { taskId: "t1", from: "in_progress", to: "done" });
    expect(await activity("writer")).toMatchObject({ doing: "waiting", what: "needs you", task: "t1" });
  });

  it("says which conversation a question was asked in, where an answer to it goes, and none for a task's", async () => {
    make();
    started("planner");
    await tool("planner", "ask_user", { question: "Window or aisle?" });
    ended("planner", { stop: { kind: "complete" } });
    expect(await activity("planner")).toMatchObject({ doing: "waiting", session: "s-planner" });
    started("writer");
    await tool("writer", "interface", { action: "send", kind: "choice", props: { question: "Which hotel?" } });
    ended("writer", { stop: { kind: "complete" } });
    expect(await activity("writer")).toMatchObject({ doing: "waiting", session: "s-writer" });
    // Asked from a task run: answered on the task, not in the run's conversation.
    started("planner");
    await tool("planner", "ask_user", { question: "Train or plane?" }, false);
    events.emit("question.asked", { question: "Train or plane?", sessionId: "s-planner", taskId: "ptask_2" });
    ended("planner", { stop: { kind: "complete" } });
    const onTask = await activity("planner");
    expect(onTask).toMatchObject({ doing: "waiting", task: "ptask_2" });
    expect(onTask.session).toBeUndefined();
  });

  it("is stuck after a turn that stalled or threw, until the next one", async () => {
    make();
    started("planner");
    ended("planner", { stop: { kind: "max-rounds", rounds: 6 } });
    expect(await doing("planner")).toBe("stuck | stuck | ran out of steps");
    started("planner");
    ended("planner", { error: "model unreachable" });
    expect(await doing("planner")).toBe("stuck | stuck | something went wrong: model unreachable");
    started("planner");
    ended("planner", { stop: { kind: "aborted", requestedByCaller: true } });
    expect(await doing("planner")).toBe("idle | idle");
  });

  it("keeps thinking while another of its turns is still running", async () => {
    make();
    started("planner", "web");
    started("planner", "discord");
    ended("planner", { stop: { kind: "complete" } }, "web");
    expect(await doing("planner")).toBe("thinking | thinking");
    ended("planner", { stop: { kind: "complete" } }, "discord");
    expect(await doing("planner")).toBe("idle | idle");
  });

  it("keeps showing the tool one turn is using when another of its turns ends", async () => {
    make();
    started("planner", "web");
    started("planner", "s-planner");
    await tool("planner", "web_fetch", { url: "https://example.com/menu" }, false);
    ended("planner", { stop: { kind: "complete" } }, "web");
    expect(await doing("planner")).toBe("working | reading a page | example.com | tablet");
  });

  it("falls asleep when paused, and wakes to answer", async () => {
    make();
    await tracker.start();
    sleeping.set("planner", "agents are paused");
    events.emit("agents.pause_changed", { paused: true, scope: "autonomous", at: "now" });
    expect(await doing("planner")).toBe("asleep | asleep | agents are paused");
    started("planner");
    expect(await doing("planner")).toBe("thinking | thinking");
    ended("planner", { stop: { kind: "complete" } });
    expect(await doing("planner")).toBe("asleep | asleep | agents are paused");
  });

  it("writes a quick tool call that settles back as nothing at all", async () => {
    vi.useFakeTimers();
    make({ settleMs: 200 });
    started("planner");
    await vi.advanceTimersByTimeAsync(250);
    await tool("planner", "read", { path: "notes.md" });
    await vi.advanceTimersByTimeAsync(250);
    await tracker.settled();
    const history = await state.history(PERSON, { type: ACTIVITY_TYPE, id: "planner" });
    expect(history.map((c) => (c.after as unknown as Activity).doing)).toEqual(["thinking"]);
  });

  it("can be read by anyone and written by no one but itself", async () => {
    await make().start();
    const agent: StateCaller = { actor: { kind: "agent", name: "writer" } };
    expect(await state.get(agent, { type: ACTIVITY_TYPE, id: "planner" })).not.toBeNull();
    await expect(
      state.put(agent, {
        type: ACTIVITY_TYPE,
        id: "planner",
        data: { agent: "planner", doing: "idle", what: "x", since: "y" },
      }),
    ).rejects.toThrow(StateError);
  });

  it("remembers the last thing it did after it goes idle: the last tool it used, and when", async () => {
    make();
    started("planner");
    await tool("planner", "recall", { query: "the trip" });
    await tool("planner", "web_search", { query: "ferries" });
    ended("planner", { stop: { kind: "complete" } });
    const idle = await activity("planner");
    expect(idle.doing).toBe("idle");
    expect(idle.last).toMatchObject({ what: "searching the web", look: "magnifier" });
    expect(Date.parse(idle.last?.at ?? "")).not.toBeNaN();
  });

  it("says a turn without a tool talked: to the agent that started it, in the room that woke it, or back", async () => {
    make({ roomName: (ref) => (ref === "local:trip" ? "trip" : undefined) });
    events.emit("room.woke", { roomRef: "local:trip", agent: "writer", messageCount: 2 });
    started("writer");
    ended("writer", { stop: { kind: "complete" } });
    roomEnded("writer", true);
    expect((await activity("writer")).last?.what).toBe("talking in #trip");
    await tool("planner", "room", { action: "dm", agent: "writer" }, false);
    started("writer", "dm");
    ended("writer", { stop: { kind: "complete" } }, "dm");
    expect((await activity("writer")).last?.what).toBe("talking to planner");
    started("default");
    ended("default", { stop: { kind: "complete" } });
    expect((await activity("default")).last?.what).toBe("replying");
  });

  it("says a room turn that posted nothing only read the room, however it kept quiet", async () => {
    make({ roomName: (ref) => (ref === "local:trip" ? "trip" : undefined) });
    // Woken, and nothing said: no tool, no reply.
    events.emit("room.woke", { roomRef: "local:trip", agent: "writer", messageCount: 1 });
    started("writer");
    ended("writer", { stop: { kind: "complete" } });
    roomEnded("writer", false);
    expect((await activity("writer")).last?.what).toBe("reading #trip");
    // Passing with the room tool, the room named by its ref.
    started("writer");
    await tool("writer", "room", { action: "pass", room: "local:trip" });
    ended("writer", { stop: { kind: "complete" } });
    roomEnded("writer", false);
    expect((await activity("writer")).last).toMatchObject({ what: "reading #trip", look: "phone" });
  });

  it("says where an agent posted, and that a reply after its tools was the last thing it did", async () => {
    make({ roomName: (ref) => (ref === "local:trip" ? "trip" : undefined) });
    started("writer");
    await tool("writer", "room", { action: "post", room: "#trip", body: "Ferries every 20 minutes" });
    ended("writer", { stop: { kind: "complete" } });
    roomEnded("writer", true);
    expect((await activity("writer")).last?.what).toBe("posting in #trip");
    // Looked something up, then answered as the turn ended: the answer is the last thing.
    events.emit("room.woke", { roomRef: "local:trip", agent: "writer", messageCount: 1 });
    started("writer");
    await tool("writer", "web_search", { query: "ferries" });
    ended("writer", { stop: { kind: "complete" } });
    roomEnded("writer", true);
    expect((await activity("writer")).last?.what).toBe("talking in #trip");
    // Looked something up and said nothing: the search is.
    started("writer");
    await tool("writer", "web_search", { query: "ferries" });
    ended("writer", { stop: { kind: "complete" } });
    roomEnded("writer", false);
    expect((await activity("writer")).last?.what).toBe("searching the web");
  });

  it("says when an idle or sleeping agent next wakes, and when a pause runs out", async () => {
    const wakes = new Map([["planner", "2026-10-19T07:00:00.000Z"]]);
    sleeping.set("writer", "paused");
    make({
      next: (agent) => wakes.get(agent) ?? null,
      asleep: (agent) => (agent === "writer" ? { why: "paused", until: "2026-10-19T09:30:00.000Z" } : null),
    });
    await tracker.start();
    expect(await activity("planner")).toMatchObject({ doing: "idle", next: "2026-10-19T07:00:00.000Z" });
    expect(await activity("writer")).toMatchObject({
      doing: "asleep",
      detail: "paused",
      until: "2026-10-19T09:30:00.000Z",
    });
    expect((await activity("default")).next).toBeUndefined();
    // Busy, it says nothing about its next wake.
    started("planner");
    expect((await activity("planner")).next).toBeUndefined();
  });

  it("writes a new next wake as it is booked, keeping when it went idle", async () => {
    const wakes = new Map<string, string>();
    make({ next: (agent) => wakes.get(agent) ?? null });
    await tracker.start();
    const before = await activity("planner");
    wakes.set("planner", "2026-10-19T07:00:00.000Z");
    tracker.refresh();
    const after = await activity("planner");
    expect(after.next).toBe("2026-10-19T07:00:00.000Z");
    expect(after.since).toBe(before.since);
  });

  it("stops listening when stopped", async () => {
    make();
    tracker.stop();
    started("planner");
    await tracker.settled();
    expect(await state.get(PERSON, { type: ACTIVITY_TYPE, id: "planner" })).toBeNull();
  });
});

describe("speech", () => {
  async function said(agent: string): Promise<Speech | undefined> {
    await tracker.settled();
    return (await state.get(PERSON, { type: SPEECH_TYPE, id: agent }))?.data as unknown as Speech | undefined;
  }
  const post = (speaker: string | undefined, body: string) =>
    events.emit("room.message", {
      roomRef: "local:trip",
      messageId: "m",
      speaker,
      to: ["writer"],
      body,
      fromSelf: true,
    });

  it("keeps the last thing an agent said in a room, for a bubble over its head", async () => {
    make();
    post("planner", "Flights are booked.\n\nHotel next.");
    expect(await said("planner")).toMatchObject({
      text: "Flights are booked. Hotel next.",
      to: ["writer"],
      room: "local:trip",
    });
  });

  it("keeps nothing for a speaker that isn't an agent", async () => {
    make();
    post("owner", "hello");
    post(undefined, "hello");
    expect(await said("owner")).toBeUndefined();
  });

  it("keeps both halves of a direct message, the answer timed to follow it", async () => {
    make();
    events.emit("agent.messaged", {
      from: "planner",
      to: "writer",
      body: "Draft the intro?",
      reply: "On it.",
      via: "dm",
    });
    const asked = await said("planner");
    const answered = await said("writer");
    expect(asked).toMatchObject({ text: "Draft the intro?", to: ["writer"] });
    expect(answered).toMatchObject({ text: "On it.", to: ["planner"] });
    expect(Date.parse(answered?.at ?? "")).toBeGreaterThan(Date.parse(asked?.at ?? ""));
    expect(asked?.room).toBeUndefined();
  });

  it("is for people only: an agent can't read what another said", async () => {
    make();
    post("planner", "secret plans");
    await tracker.settled();
    const agent: StateCaller = { actor: { kind: "agent", name: "writer" } };
    await expect(state.get(agent, { type: SPEECH_TYPE, id: "planner" })).rejects.toThrow(StateError);
  });

  it("keeps nothing when told not to", async () => {
    make({ speech: false });
    post("planner", "hello");
    events.emit("agent.messaged", { from: "planner", to: "writer", body: "hi", reply: "hey", via: "dm" });
    expect(await said("planner")).toBeUndefined();
    expect(await said("writer")).toBeUndefined();
  });

  it("cuts a long line short", async () => {
    make();
    post("planner", "word ".repeat(200));
    expect((await said("planner"))?.text.length).toBeLessThanOrEqual(280);
  });
});

describe("whyAsleep", () => {
  const now = new Date("2026-10-18T12:00:00Z");
  it("sleeps everyone while agents are paused", () => {
    expect(whyAsleep({ paused: true, own: null, now })).toBe("agents are paused");
  });
  it("reuses an online agent's own switch: off, or paused until later", () => {
    expect(whyAsleep({ paused: false, own: { enabled: false, paused_until: null }, now })).toBe("switched off");
    expect(whyAsleep({ paused: false, own: { enabled: true, paused_until: "2026-10-18T13:00:00Z" }, now })).toBe(
      "paused",
    );
  });
  it("wakes once a pause has run out, and for an agent with no switch", () => {
    expect(whyAsleep({ paused: false, own: { enabled: true, paused_until: "2026-10-18T11:00:00Z" }, now })).toBeNull();
    expect(whyAsleep({ paused: false, own: null, now })).toBeNull();
  });
});

describe("nextWake", () => {
  const now = new Date("2026-10-19T02:00:00.000Z");
  it("is the wake it booked", () => {
    expect(nextWake({ booked: "2026-10-19T07:00:00.000Z", own: null, now })).toBe("2026-10-19T07:00:00.000Z");
  });
  it("is its own next turn: the last one plus the interval it is on", () => {
    const own = { last: "2026-10-19T01:30:00.000Z", intervalMs: 60 * 60_000 };
    expect(nextWake({ booked: null, own, now })).toBe("2026-10-19T02:30:00.000Z");
  });
  it("is whichever comes first", () => {
    const own = { last: "2026-10-19T01:30:00.000Z", intervalMs: 60 * 60_000 };
    expect(nextWake({ booked: "2026-10-19T02:10:00.000Z", own, now })).toBe("2026-10-19T02:10:00.000Z");
    expect(nextWake({ booked: "2026-10-19T07:00:00.000Z", own, now })).toBe("2026-10-19T02:30:00.000Z");
  });
  it("stays the same time once it has passed, however often it is asked, so the record isn't rewritten", () => {
    const own = { last: "2026-10-18T20:00:00.000Z", intervalMs: 60_000 };
    const first = nextWake({ booked: null, own, now });
    expect(first).toBe("2026-10-18T20:01:00.000Z");
    expect(nextWake({ booked: null, own, now: new Date(now.getTime() + 5_000) })).toBe(first);
    const booked = "2026-10-19T01:59:00.000Z";
    expect(nextWake({ booked, own: null, now: new Date(now.getTime() + 5_000) })).toBe(booked);
  });
  it("is when its hours next start, for a turn due or overdue outside them, the same on every look", () => {
    const window = { start: "07:00", end: "22:00" };
    // 02:00 UTC, overdue since 20:01 the evening before: the window opens at 07:00.
    const own = { last: "2026-10-18T20:00:00.000Z", intervalMs: 60_000, window, timeZone: "UTC" };
    expect(nextWake({ booked: null, own, now })).toBe("2026-10-19T07:00:00.000Z");
    expect(nextWake({ booked: null, own, now: new Date(now.getTime() + 61_234) })).toBe("2026-10-19T07:00:00.000Z");
    // Due later tonight, still outside: the same.
    const later = { ...own, last: "2026-10-19T01:30:00.000Z", intervalMs: 60 * 60_000 };
    expect(nextWake({ booked: null, own: later, now })).toBe("2026-10-19T07:00:00.000Z");
    // Due inside its hours: then. In another time zone, by that zone's clock.
    const day = { ...own, last: "2026-10-19T08:00:00.000Z", intervalMs: 30 * 60_000 };
    expect(nextWake({ booked: null, own: day, now })).toBe("2026-10-19T08:30:00.000Z");
    const ny = { ...own, timeZone: "America/New_York" };
    expect(nextWake({ booked: null, own: ny, now })).toBe("2026-10-19T11:00:00.000Z");
    // Hours that never come: nothing.
    expect(nextWake({ booked: null, own: { ...own, window: { start: "07:00", end: "7:00" } }, now })).toBeNull();
  });
  it("waits for the day's limit to lift", () => {
    const own = { last: "2026-10-19T01:30:00.000Z", intervalMs: 60 * 60_000, notBefore: "2026-10-20T00:00:00.000Z" };
    expect(nextWake({ booked: null, own, now })).toBe("2026-10-20T00:00:00.000Z");
  });
  it("is nothing when nothing will wake it, or before its first turn", () => {
    expect(nextWake({ booked: null, own: null, now })).toBeNull();
    expect(nextWake({ booked: null, own: { last: null, intervalMs: 60_000 }, now })).toBeNull();
    expect(nextWake({ booked: null, own: { last: "2026-10-19T01:00:00.000Z", intervalMs: 0 }, now })).toBeNull();
  });
});

describe("the activity plugin", () => {
  it("registers nothing when no agent has a body", () => {
    const registered: unknown[] = [];
    const out = plugin({
      runtime: { getConfig: () => ({ agents: {} }) },
      stateTypes: { register: (def: unknown) => registered.push(def) },
      events,
      config: {},
    } as never);
    expect(out).toBeUndefined();
    expect(registered).toEqual([]);
  });
});
