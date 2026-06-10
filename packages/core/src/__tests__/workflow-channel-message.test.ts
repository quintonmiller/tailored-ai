import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutboundNotifier } from "../channels/outbound.js";
import { initDatabase } from "../db/schema.js";
import { WorkflowEngine } from "../workflows/engine.js";
import { ChannelMessageExecutor } from "../workflows/executors/channel-message.js";
import { WorkflowRegistry } from "../workflows/registry.js";

let db: Database.Database;
let registry: WorkflowRegistry;
let engine: WorkflowEngine;

function makeNotifier(id = "discord"): OutboundNotifier & {
  send: ReturnType<typeof vi.fn>;
  sendDM: ReturnType<typeof vi.fn>;
} {
  return {
    id,
    send: vi.fn(async () => undefined),
    sendDM: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  db = initDatabase(":memory:");
  registry = new WorkflowRegistry();
});

afterEach(() => {
  db.close();
});

describe("ChannelMessageExecutor", () => {
  it("DMs the configured owner when no target is specified", async () => {
    const notifier = makeNotifier();
    engine = new WorkflowEngine({
      db,
      registry,
      executors: [new ChannelMessageExecutor({ resolveOutbound: () => notifier, getOwnerId: () => "OWNER123" })],
    });
    registry.register({
      name: "wf",
      steps: [{ name: "notify", type: "channel_message", message: "Hello ${input.who}" }],
    });

    const run = await engine.runWorkflow("wf", { who: "alice" });
    expect(run.status).toBe("completed");
    expect(notifier.sendDM).toHaveBeenCalledWith("OWNER123", "Hello alice");
    expect(notifier.send).not.toHaveBeenCalled();
  });

  it("resolves the outbound channel from the step's channel id", async () => {
    const slack = makeNotifier("slack");
    const resolveOutbound = vi.fn((id?: string) => (id === "slack" ? slack : undefined));
    engine = new WorkflowEngine({
      db,
      registry,
      executors: [new ChannelMessageExecutor({ resolveOutbound, getOwnerId: () => "OWNER123" })],
    });
    registry.register({
      name: "wf",
      steps: [{ name: "notify", type: "channel_message", channel: "slack", message: "hi" }],
    });

    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("completed");
    expect(resolveOutbound).toHaveBeenCalledWith("slack");
    expect(slack.sendDM).toHaveBeenCalledWith("OWNER123", "hi");
  });

  it("posts to a specific channel when channelId is set", async () => {
    const notifier = makeNotifier();
    engine = new WorkflowEngine({
      db,
      registry,
      executors: [new ChannelMessageExecutor({ resolveOutbound: () => notifier, getOwnerId: () => undefined })],
    });
    registry.register({
      name: "wf",
      steps: [{ name: "notify", type: "channel_message", message: "ship it", channelId: "CHAN42" }],
    });

    await engine.runWorkflow("wf");
    expect(notifier.send).toHaveBeenCalledWith("CHAN42", "ship it");
    expect(notifier.sendDM).not.toHaveBeenCalled();
  });

  it("DMs an explicit userId when set", async () => {
    const notifier = makeNotifier();
    engine = new WorkflowEngine({
      db,
      registry,
      executors: [new ChannelMessageExecutor({ resolveOutbound: () => notifier, getOwnerId: () => "OWNER" })],
    });
    registry.register({
      name: "wf",
      steps: [{ name: "notify", type: "channel_message", message: "hi", userId: "USER7" }],
    });

    await engine.runWorkflow("wf");
    expect(notifier.sendDM).toHaveBeenCalledWith("USER7", "hi");
  });

  it("fails the run when no channel is connected", async () => {
    engine = new WorkflowEngine({
      db,
      registry,
      executors: [new ChannelMessageExecutor({ resolveOutbound: () => undefined, getOwnerId: () => "OWNER" })],
    });
    registry.register({
      name: "wf",
      steps: [{ name: "notify", type: "channel_message", message: "x" }],
    });

    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("failed");
    expect(run.error).toContain("no outbound channel is connected");
  });

  it("fails with a clear error when neither target nor owner is configured", async () => {
    const notifier = makeNotifier();
    engine = new WorkflowEngine({
      db,
      registry,
      executors: [new ChannelMessageExecutor({ resolveOutbound: () => notifier, getOwnerId: () => undefined })],
    });
    registry.register({
      name: "wf",
      steps: [{ name: "notify", type: "channel_message", message: "x" }],
    });

    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("failed");
    expect(run.error).toContain("no channelId or userId");
  });
});
