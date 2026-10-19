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
    events.emit("approval.settled", { ...approval, outcome: "approved", timedOut: false } as never);
    expect(await doing("planner")).toBe("thinking | thinking");
  });

  it("needs you when a task does", async () => {
    make();
    events.emit("task.needs_human", { taskId: "t", agentName: "writer", reason: "question", message: "Which tone?" });
    expect(await doing("writer")).toBe("waiting | needs you | Which tone?");
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

  it("stops listening when stopped", async () => {
    make();
    tracker.stop();
    started("planner");
    await tracker.settled();
    expect(await state.get(PERSON, { type: ACTIVITY_TYPE, id: "planner" })).toBeNull();
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
