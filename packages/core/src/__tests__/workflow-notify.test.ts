import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboundNotifier } from "../channels/outbound.js";
import { initDatabase } from "../db/schema.js";
import { WorkflowEngine } from "../workflows/engine.js";
import { type EmailSender, NotifyExecutor } from "../workflows/executors/notify.js";
import { WorkflowRegistry } from "../workflows/registry.js";

let db: Database.Database;
let registry: WorkflowRegistry;

beforeEach(() => {
  db = initDatabase(":memory:");
  registry = new WorkflowRegistry();
});

afterEach(() => {
  db.close();
});

function fakeNotifier(id = "discord"): OutboundNotifier {
  return {
    id,
    send: vi.fn(async () => {}),
    sendDM: vi.fn(async () => {}),
  };
}

function fakeEmail() {
  return {
    send: vi.fn(async () => {}),
  } satisfies EmailSender;
}

describe("NotifyExecutor", () => {
  it("log channel writes to the supplied log sink", async () => {
    const logs: string[] = [];
    const engine = new WorkflowEngine({
      db,
      registry,
      executors: [
        new NotifyExecutor({
          resolveOutbound: () => undefined,
          getOwnerId: () => undefined,
          log: (m) => logs.push(m),
        }),
      ],
    });
    registry.register({
      name: "wf",
      steps: [{ name: "say", type: "notify", channel: "log", message: "hello ${input.who}" }],
    });
    const run = await engine.runWorkflow("wf", { who: "world" });
    expect(run.status).toBe("completed");
    expect(logs).toEqual(["hello world"]);
  });

  it("channel falls back to owner DM when no target is set", async () => {
    const notifier = fakeNotifier();
    const engine = new WorkflowEngine({
      db,
      registry,
      executors: [
        new NotifyExecutor({
          resolveOutbound: () => notifier,
          getOwnerId: () => "owner123",
        }),
      ],
    });
    registry.register({
      name: "wf",
      steps: [{ name: "ping", type: "notify", channel: "discord", message: "ping" }],
    });
    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("completed");
    expect(notifier.sendDM).toHaveBeenCalledWith("owner123", "ping");
  });

  it("dispatches to an arbitrary registered channel id", async () => {
    const slack = fakeNotifier("slack");
    const resolveOutbound = vi.fn((id?: string) => (id === "slack" ? slack : undefined));
    const engine = new WorkflowEngine({
      db,
      registry,
      executors: [
        new NotifyExecutor({
          resolveOutbound,
          getOwnerId: () => "owner123",
        }),
      ],
    });
    registry.register({
      name: "wf",
      steps: [{ name: "ping", type: "notify", channel: "slack", message: "ping" }],
    });
    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("completed");
    expect(resolveOutbound).toHaveBeenCalledWith("slack");
    expect(slack.sendDM).toHaveBeenCalledWith("owner123", "ping");
  });

  it("channel honours explicit channelId", async () => {
    const notifier = fakeNotifier();
    const engine = new WorkflowEngine({
      db,
      registry,
      executors: [
        new NotifyExecutor({
          resolveOutbound: () => notifier,
          getOwnerId: () => "owner123",
        }),
      ],
    });
    registry.register({
      name: "wf",
      steps: [
        {
          name: "ping",
          type: "notify",
          channel: "discord",
          message: "ping",
          channelId: "ch-1",
        },
      ],
    });
    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("completed");
    expect(notifier.send).toHaveBeenCalledWith("ch-1", "ping");
    expect(notifier.sendDM).not.toHaveBeenCalled();
  });

  it("email channel dispatches through the configured sender", async () => {
    const email = fakeEmail();
    const engine = new WorkflowEngine({
      db,
      registry,
      executors: [
        new NotifyExecutor({
          resolveOutbound: () => undefined,
          getOwnerId: () => undefined,
          getEmail: () => email,
        }),
      ],
    });
    registry.register({
      name: "wf",
      steps: [
        {
          name: "send",
          type: "notify",
          channel: "email",
          to: "a@example.com, b@example.com",
          subject: "Hello ${input.who}",
          message: "Body here",
        },
      ],
    });
    const run = await engine.runWorkflow("wf", { who: "alice" });
    expect(run.status).toBe("completed");
    expect(email.send).toHaveBeenCalledWith({
      to: ["a@example.com", "b@example.com"],
      subject: "Hello alice",
      body: "Body here",
    });
  });

  it("email channel without a backend surfaces a clear error", async () => {
    const engine = new WorkflowEngine({
      db,
      registry,
      executors: [
        new NotifyExecutor({
          resolveOutbound: () => undefined,
          getOwnerId: () => undefined,
        }),
      ],
    });
    registry.register({
      name: "wf",
      steps: [{ name: "send", type: "notify", channel: "email", to: "a@x", message: "x" }],
    });
    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/no email backend/);
  });
});
