/**
 * Discord notifier default-plugin tests — Slice 3 of the platform
 * vision (`docs/platform-vision.md`). These cover the suppress-delivery
 * filter, the structured envelope, the agent-completed subscription,
 * and the deliver branches. Previously these lived inside
 * task-watcher-notification.test.ts; the formatter moved with the code.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDatabase } from "../db/schema.js";
import { addTaskComment, createProjectTask } from "../db/task-queries.js";
import { TypedEventBus } from "../events.js";
import { buildNotification, DiscordNotifier } from "../plugins/discord-notifier.js";
import type { AgentRuntime } from "../runtime.js";

let db: Database.Database;

function makeRuntime(
  over: Record<string, unknown> = {},
  outbound?: { id?: string; send: (...a: unknown[]) => unknown; sendDM: (...a: unknown[]) => unknown },
): AgentRuntime {
  const events = new TypedEventBus();
  const sink = outbound ? { id: "discord", ...outbound } : undefined;
  return {
    db,
    events,
    getConfig: () => ({
      agents: { coder: { description: "" }, reviewer: { description: "" } },
      channels: { discord: { owner: "1234" } },
      taskWatcher: { enabled: true, delivery: { channel: "log" } },
      ...over,
    }),
    // Mirror the real runtime's outbound registry: the DiscordNotifier
    // resolves its sink by channel id at delivery time (#66).
    getOutbound: (id: string) => (id === "discord" ? sink : undefined),
    getOwnerId: (id?: string) => (id === "discord" || id === undefined ? "1234" : undefined),
  } as unknown as AgentRuntime;
}

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

describe("DiscordNotifier suppress-delivery filter", () => {
  it("suppresses delivery when assignee is a known agent and status is in-flight", () => {
    const n = new DiscordNotifier({ runtime: makeRuntime() });
    expect(n.shouldSuppressDelivery("coder", "in_progress")).toBe(true);
    expect(n.shouldSuppressDelivery("reviewer", "in_review")).toBe(true);
    n.stop();
  });

  it("delivers when assignee is a person (not a defined agent)", () => {
    const n = new DiscordNotifier({ runtime: makeRuntime() });
    expect(n.shouldSuppressDelivery("Quinton", "in_review")).toBe(false);
    expect(n.shouldSuppressDelivery("107389829628612608", "in_review")).toBe(false);
    n.stop();
  });

  it("always delivers terminal/blocked statuses regardless of assignee", () => {
    const n = new DiscordNotifier({ runtime: makeRuntime() });
    expect(n.shouldSuppressDelivery("coder", "blocked")).toBe(false);
    expect(n.shouldSuppressDelivery("coder", "done")).toBe(false);
    expect(n.shouldSuppressDelivery(null, "done")).toBe(false);
    n.stop();
  });

  it("delivers when no assignee at all (triage ping)", () => {
    const n = new DiscordNotifier({ runtime: makeRuntime() });
    expect(n.shouldSuppressDelivery(null, "backlog")).toBe(false);
    n.stop();
  });
});

describe("DiscordNotifier envelope (buildNotification)", () => {
  function isKnownAgent(name: string) {
    return name === "coder" || name === "reviewer";
  }

  it("renders task id, title, status, assignee in the header", async () => {
    const task = createProjectTask(db, { title: "Add foo support" });
    const final = { id: task.id, title: "Add foo support", status: "in_review" };
    const msg = await buildNotification(db, final, "Quinton", "in_review", "", isKnownAgent);
    expect(msg).toContain(task.id);
    expect(msg).toContain("Add foo support");
    expect(msg).toContain("status: in_review");
    expect(msg).toContain("assignee: Quinton");
  });

  it("surfaces the latest task comment as a blockquote", async () => {
    const task = createProjectTask(db, { title: "T" });
    addTaskComment(db, task.id, { author: "reviewer", content: "APPROVED — looks great" });
    const final = { id: task.id, title: "T", status: "in_review" };
    const msg = await buildNotification(db, final, "Quinton", "in_review", "", isKnownAgent);
    expect(msg).toContain("> *reviewer*:");
    expect(msg).toContain("APPROVED — looks great");
  });

  it("includes merge commands when latest comment references a branch", async () => {
    const task = createProjectTask(db, { title: "T" });
    addTaskComment(db, task.id, {
      author: "coder",
      content: "Branch: agent/feature-x. Commit: abc1234. Summary: did the thing.",
    });
    const final = { id: task.id, title: "T", status: "in_review" };
    const msg = await buildNotification(db, final, "Quinton", "in_review", "", isKnownAgent);
    expect(msg).toContain("ready for your review");
    expect(msg).toContain("git diff main..agent/feature-x");
    expect(msg).toContain("git merge --ff-only agent/feature-x");
  });

  it("emojis match the status (in_review with human assignee = 🔍, blocked = 🚫, done = ✅)", async () => {
    const task = createProjectTask(db, { title: "T" });
    const final = { id: task.id, title: "T", status: "done" };
    const done = await buildNotification(db, final, null, "done", "", isKnownAgent);
    expect(done).toContain("✅");
    const blocked = await buildNotification(db, { ...final, status: "blocked" }, null, "blocked", "", isKnownAgent);
    expect(blocked).toContain("🚫");
  });

  it("does not duplicate agent response when it overlaps with latest comment", async () => {
    const task = createProjectTask(db, { title: "T" });
    addTaskComment(db, task.id, {
      author: "reviewer",
      content: "Long detailed approved review with many points and so on...",
    });
    const final = { id: task.id, title: "T", status: "in_review" };
    const msg = await buildNotification(
      db,
      final,
      "Quinton",
      "in_review",
      "Long detailed approved review with many points and so on... extra trailing text",
      isKnownAgent,
    );
    const occurrences = (msg.match(/Long detailed approved review/g) ?? []).length;
    expect(occurrences).toBe(1);
  });
});

describe("DiscordNotifier subscription to agent.completed", () => {
  it("delivers via the configured channel notifier when status is terminal", async () => {
    const sendDM = vi.fn().mockResolvedValue(undefined);
    const runtime = makeRuntime(
      { taskWatcher: { enabled: true, delivery: { channel: "discord-dm", target: "user-abc" } } },
      { send: vi.fn(), sendDM },
    );
    const n = new DiscordNotifier({ runtime });

    const task = createProjectTask(db, { title: "Ship it" });
    runtime.events.emit("agent.completed", {
      taskId: task.id,
      agentName: "coder",
      action: "updated",
      task: { id: task.id, title: "Ship it", status: "in_progress", assignee: "coder" },
      finalTask: { id: task.id, title: "Ship it", status: "done", assignee: null },
      response: "shipped",
    });

    // Handler is async; let the microtask queue drain.
    await new Promise((r) => setTimeout(r, 0));
    expect(sendDM).toHaveBeenCalledTimes(1);
    expect(sendDM.mock.calls[0][0]).toBe("user-abc");
    expect(sendDM.mock.calls[0][1]).toContain(task.id);
    n.stop();
  });

  it("does NOT deliver when an agent is still in-flight", async () => {
    const sendDM = vi.fn();
    const runtime = makeRuntime(
      { taskWatcher: { enabled: true, delivery: { channel: "discord-dm", target: "user-abc" } } },
      { send: vi.fn(), sendDM },
    );
    const n = new DiscordNotifier({ runtime });

    const task = createProjectTask(db, { title: "Mid-handoff" });
    runtime.events.emit("agent.completed", {
      taskId: task.id,
      agentName: "coder",
      action: "updated",
      task: { id: task.id, title: "Mid-handoff", status: "in_progress", assignee: "coder" },
      finalTask: { id: task.id, title: "Mid-handoff", status: "in_review", assignee: "reviewer" },
      response: "handed off",
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(sendDM).not.toHaveBeenCalled();
    n.stop();
  });

  it("logs (no DM) when delivery channel is 'log'", async () => {
    const sendDM = vi.fn();
    const runtime = makeRuntime(
      { taskWatcher: { enabled: true, delivery: { channel: "log" } } },
      { send: vi.fn(), sendDM },
    );
    const n = new DiscordNotifier({ runtime });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const task = createProjectTask(db, { title: "logged" });
    runtime.events.emit("agent.completed", {
      taskId: task.id,
      agentName: undefined,
      action: "created",
      task: { id: task.id, title: "logged", status: "blocked", assignee: null },
      finalTask: { id: task.id, title: "logged", status: "blocked", assignee: null },
      response: "",
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(sendDM).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
    n.stop();
  });

  it("stop() disposes the subscription so later events are ignored", async () => {
    const sendDM = vi.fn();
    const runtime = makeRuntime(
      { taskWatcher: { enabled: true, delivery: { channel: "discord-dm", target: "user-abc" } } },
      { send: vi.fn(), sendDM },
    );
    const n = new DiscordNotifier({ runtime });
    n.stop();

    const task = createProjectTask(db, { title: "ignored" });
    runtime.events.emit("agent.completed", {
      taskId: task.id,
      agentName: undefined,
      action: "updated",
      task: { id: task.id, title: "ignored", status: "in_progress", assignee: null },
      finalTask: { id: task.id, title: "ignored", status: "done", assignee: null },
      response: "",
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(sendDM).not.toHaveBeenCalled();
  });
});
