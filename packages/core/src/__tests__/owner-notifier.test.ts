/**
 * Owner notifier default-plugin tests (#205). Cover the four events the
 * plugin delivers — `task.needs_human`, `digest.ready`, `question.asked`,
 * `form.completed` — through a fake outbound notifier, plus the autopilot
 * quiet-hours suppression the plugin owns. These pin the behavior the inline
 * autopilot-worker / ask_user / channel_message owner-DM calls used to have.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboundNotifier } from "../channels/outbound.js";
import { updateAutopilotSettings } from "../db/autopilot-queries.js";
import { initDatabase } from "../db/schema.js";
import { TypedEventBus } from "../events.js";
import { OwnerNotifier } from "../plugins/owner-notifier.js";
import type { AgentRuntime } from "../runtime.js";

let db: Database.Database;

function makeNotifier(): OutboundNotifier & { send: ReturnType<typeof vi.fn>; sendDM: ReturnType<typeof vi.fn> } {
  return {
    id: "discord",
    send: vi.fn(async () => undefined),
    sendDM: vi.fn(async () => undefined),
  };
}

function makeRuntime(opts: { events: TypedEventBus; outbound?: OutboundNotifier; ownerId?: string }): AgentRuntime {
  return {
    db,
    events: opts.events,
    resolveOutbound: () => opts.outbound,
    getOwnerId: () => opts.ownerId,
    getConfig: () => ({}),
  } as unknown as AgentRuntime;
}

beforeEach(() => {
  db = initDatabase(":memory:");
  // Pin the wall clock to local noon so quiet-hours windows are deterministic.
  vi.useFakeTimers();
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  vi.setSystemTime(noon);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
});

describe("OwnerNotifier", () => {
  it("delivers task.needs_human as an owner DM", async () => {
    const events = new TypedEventBus();
    const out = makeNotifier();
    const notifier = new OwnerNotifier({ runtime: makeRuntime({ events, outbound: out, ownerId: "OWNER" }) });

    events.emit("task.needs_human", { taskId: "ptask_1", reason: "error", message: "Task ptask_1 errored: x\nboom" });
    await Promise.resolve();
    await Promise.resolve();

    expect(out.sendDM).toHaveBeenCalledWith("OWNER", "Task ptask_1 errored: x\nboom");
    notifier.stop();
  });

  it("suppresses task.needs_human during autopilot quiet hours", async () => {
    // A window covering the whole day so any test clock lands inside it.
    updateAutopilotSettings(db, { quiet_start: "00:00", quiet_end: "23:59" });
    const events = new TypedEventBus();
    const out = makeNotifier();
    const notifier = new OwnerNotifier({ runtime: makeRuntime({ events, outbound: out, ownerId: "OWNER" }) });

    events.emit("task.needs_human", { taskId: "ptask_1", reason: "error", message: "quiet please" });
    await Promise.resolve();
    await Promise.resolve();

    expect(out.sendDM).not.toHaveBeenCalled();
    notifier.stop();
  });

  it("delivers digest.ready regardless of quiet hours", async () => {
    updateAutopilotSettings(db, { quiet_start: "00:00", quiet_end: "23:59" });
    const events = new TypedEventBus();
    const out = makeNotifier();
    const notifier = new OwnerNotifier({ runtime: makeRuntime({ events, outbound: out, ownerId: "OWNER" }) });

    events.emit("digest.ready", { content: "daily summary", periodLabel: "Morning" });
    await Promise.resolve();
    await Promise.resolve();

    expect(out.sendDM).toHaveBeenCalledWith("OWNER", "daily summary");
    notifier.stop();
  });

  it("delivers an autopilot question with the blocked-task framing", async () => {
    const events = new TypedEventBus();
    const out = makeNotifier();
    const notifier = new OwnerNotifier({ runtime: makeRuntime({ events, outbound: out, ownerId: "OWNER" }) });

    events.emit("question.asked", { question: "What's the budget?", taskId: "ptask_9" });
    await Promise.resolve();
    await Promise.resolve();

    expect(out.sendDM).toHaveBeenCalledWith(
      "OWNER",
      "Task ptask_9 is blocked — agent needs input:\nWhat's the budget?",
    );
    notifier.stop();
  });

  it("suppresses an autopilot question during quiet hours but not a plain one", async () => {
    updateAutopilotSettings(db, { quiet_start: "00:00", quiet_end: "23:59" });
    const events = new TypedEventBus();
    const out = makeNotifier();
    const notifier = new OwnerNotifier({ runtime: makeRuntime({ events, outbound: out, ownerId: "OWNER" }) });

    events.emit("question.asked", { question: "task q", taskId: "ptask_9" });
    await Promise.resolve();
    await Promise.resolve();
    expect(out.sendDM).not.toHaveBeenCalled();

    // No taskId → not an autopilot question → always delivered.
    events.emit("question.asked", { question: "plain q" });
    await Promise.resolve();
    await Promise.resolve();
    expect(out.sendDM).toHaveBeenCalledWith("OWNER", "Question from autonomous agent:\nplain q");
    notifier.stop();
  });

  it("delivers form.completed as an owner DM", async () => {
    const events = new TypedEventBus();
    const out = makeNotifier();
    const notifier = new OwnerNotifier({ runtime: makeRuntime({ events, outbound: out, ownerId: "OWNER" }) });

    events.emit("form.completed", { message: "form ready", runId: "r1", stepName: "notify" });
    await Promise.resolve();
    await Promise.resolve();

    expect(out.sendDM).toHaveBeenCalledWith("OWNER", "form ready");
    notifier.stop();
  });

  it("no-ops delivery when no channel is connected", async () => {
    const events = new TypedEventBus();
    const notifier = new OwnerNotifier({ runtime: makeRuntime({ events, outbound: undefined, ownerId: "OWNER" }) });

    // Should not throw with no outbound registered.
    events.emit("task.needs_human", { taskId: "t", reason: "error", message: "x" });
    events.emit("digest.ready", { content: "d", periodLabel: "Morning" });
    events.emit("form.completed", { message: "f" });
    await Promise.resolve();
    await Promise.resolve();
    notifier.stop();
  });

  it("stops listening after stop()", async () => {
    const events = new TypedEventBus();
    const out = makeNotifier();
    const notifier = new OwnerNotifier({ runtime: makeRuntime({ events, outbound: out, ownerId: "OWNER" }) });
    notifier.stop();

    events.emit("digest.ready", { content: "after stop", periodLabel: "Morning" });
    await Promise.resolve();
    await Promise.resolve();
    expect(out.sendDM).not.toHaveBeenCalled();
    expect(events.listenerCount("digest.ready")).toBe(0);
  });
});
