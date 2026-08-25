/**
 * The first core waterfall: the slot list a turn is about to render.
 *
 * `renderContextSlots` is already a pure function over a slot list, which is
 * why it is the smallest honest place to prove the loop's bus carries weight —
 * a subscriber that drops, adds or reorders a slot needs to know nothing about
 * how the system prompt is composed.
 *
 * The list is dispatched *before* rendering, so a subscriber can stop a slot
 * running rather than discard what it produced. These tests assert that by
 * watching whether `render` was called, not only whether its text arrived.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ContextSlot, clearContextSlots, registerContextSlot } from "../agent/context-slots.js";
import { runAgentLoop } from "../agent/loop.js";
import { newSession } from "../agent/session.js";
import { initDatabase } from "../db/schema.js";
import { TypedEventBus } from "../events.js";
import type { AIProvider, ChatParams, ChatResponse } from "../providers/interface.js";

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

function capturingProvider(seen: ChatParams[]): AIProvider {
  return {
    id: "fake",
    name: "fake",
    supportsTools: true,
    async chat(params: ChatParams): Promise<ChatResponse> {
      seen.push(params);
      return { content: "ok", usage: { input: 0, output: 0 }, finishReason: "stop" };
    },
  };
}

/** A standing slot, so its text lands in the system prompt where it is easy to assert on. */
function standing(id: string, body: string, onRender?: () => void): ContextSlot {
  return {
    id,
    refresh: "reload",
    render: () => {
      onRender?.();
      return body;
    },
  };
}

function run(seen: ChatParams[], over: Record<string, unknown> = {}) {
  return runAgentLoop("go", {
    provider: capturingProvider(seen),
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

const systemOf = (seen: ChatParams[]): string => String(seen[0].messages[0].content);

describe("agent.context_slots", () => {
  it("changes nothing when no bus is passed", async () => {
    registerContextSlot(standing("a", "SLOT-A"));
    const seen: ChatParams[] = [];
    await run(seen);

    expect(systemOf(seen)).toContain("SLOT-A");
  });

  it("changes nothing when a bus has no subscribers", async () => {
    // The property that makes this safe to land before any consumer: an empty
    // chain returns the payload it was handed, so the assembled prompt is
    // byte-identical to the one built without a bus.
    registerContextSlot(standing("a", "SLOT-A"));
    const withoutBus: ChatParams[] = [];
    const withBus: ChatParams[] = [];

    await run(withoutBus);
    await run(withBus, { events: new TypedEventBus() });

    expect(systemOf(withBus)).toBe(systemOf(withoutBus));
  });

  it("lets a subscriber drop a slot before it renders", async () => {
    const rendered = vi.fn();
    registerContextSlot(standing("keep", "SLOT-KEEP"));
    registerContextSlot(standing("drop", "SLOT-DROP", rendered));

    const events = new TypedEventBus();
    events.onWaterfall("agent.context_slots", (payload, next) =>
      next({ ...payload, slots: payload.slots.filter((s) => s.id !== "drop") }),
    );

    const seen: ChatParams[] = [];
    await run(seen, { events });

    expect(systemOf(seen)).toContain("SLOT-KEEP");
    expect(systemOf(seen)).not.toContain("SLOT-DROP");
    // The point of dispatching before rendering: a slot that is expensive, or
    // that reads something unavailable, is better not called than called and
    // thrown away.
    expect(rendered).not.toHaveBeenCalled();
  });

  it("lets a subscriber add a slot the runtime never registered", async () => {
    const events = new TypedEventBus();
    events.onWaterfall("agent.context_slots", (payload, next) =>
      next({ ...payload, slots: [...payload.slots, standing("added", "SLOT-ADDED")] }),
    );

    const seen: ChatParams[] = [];
    await run(seen, { events });

    expect(systemOf(seen)).toContain("SLOT-ADDED");
  });

  it("lets a subscriber reorder, and the prompt follows", async () => {
    registerContextSlot(standing("first", "SLOT-ONE"));
    registerContextSlot(standing("second", "SLOT-TWO"));

    const events = new TypedEventBus();
    events.onWaterfall("agent.context_slots", (payload, next) =>
      next({ ...payload, slots: [...payload.slots].reverse() }),
    );

    const seen: ChatParams[] = [];
    await run(seen, { events });

    const system = systemOf(seen);
    expect(system.indexOf("SLOT-TWO")).toBeLessThan(system.indexOf("SLOT-ONE"));
  });

  it("carries the turn's context so a subscriber can decide per agent", async () => {
    const payloads: Array<{ agent?: string; sessionId: string; userMessage: string }> = [];
    const events = new TypedEventBus();
    events.onWaterfall("agent.context_slots", (payload, next) => {
      payloads.push({ agent: payload.agent, sessionId: payload.sessionId, userMessage: payload.userMessage });
      return next(payload);
    });

    await run([], { events, toolContextExtras: { agentName: "planner" } });

    expect(payloads).toHaveLength(1);
    expect(payloads[0].userMessage).toBe("go");
    expect(payloads[0].sessionId).toBeTruthy();
  });

  it("keeps the turn running when a subscriber throws", async () => {
    // Matching the rest of the bus: a throwing listener is skipped and the
    // chain continues with the payload it was handed. A broken observability
    // plugin must not be able to empty an agent's context.
    registerContextSlot(standing("a", "SLOT-A"));
    const events = new TypedEventBus();
    events.onWaterfall("agent.context_slots", () => {
      throw new Error("subscriber is broken");
    });

    const seen: ChatParams[] = [];
    const reply = await run(seen, { events });

    expect(reply).toBe("ok");
    expect(systemOf(seen)).toContain("SLOT-A");
  });
});
