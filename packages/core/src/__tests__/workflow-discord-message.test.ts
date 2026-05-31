import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDatabase } from "../db/schema.js";
import { WorkflowEngine } from "../workflows/engine.js";
import { DiscordMessageExecutor, type DiscordSender } from "../workflows/executors/discord-message.js";
import { WorkflowRegistry } from "../workflows/registry.js";

let db: Database.Database;
let registry: WorkflowRegistry;
let engine: WorkflowEngine;

function makeDiscord(): DiscordSender & { send: ReturnType<typeof vi.fn>; sendDM: ReturnType<typeof vi.fn> } {
  return {
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

describe("DiscordMessageExecutor", () => {
  it("DMs the configured owner when no target is specified", async () => {
    const discord = makeDiscord();
    engine = new WorkflowEngine({
      db,
      registry,
      executors: [new DiscordMessageExecutor({ getDiscord: () => discord, getOwnerId: () => "OWNER123" })],
    });
    registry.register({
      name: "wf",
      steps: [{ name: "notify", type: "discord_message", message: "Hello ${input.who}" }],
    });

    const run = await engine.runWorkflow("wf", { who: "alice" });
    expect(run.status).toBe("completed");
    expect(discord.sendDM).toHaveBeenCalledWith("OWNER123", "Hello alice");
    expect(discord.send).not.toHaveBeenCalled();
  });

  it("posts to a specific channel when channelId is set", async () => {
    const discord = makeDiscord();
    engine = new WorkflowEngine({
      db,
      registry,
      executors: [new DiscordMessageExecutor({ getDiscord: () => discord, getOwnerId: () => undefined })],
    });
    registry.register({
      name: "wf",
      steps: [{ name: "notify", type: "discord_message", message: "ship it", channelId: "CHAN42" }],
    });

    await engine.runWorkflow("wf");
    expect(discord.send).toHaveBeenCalledWith("CHAN42", "ship it");
    expect(discord.sendDM).not.toHaveBeenCalled();
  });

  it("DMs an explicit userId when set", async () => {
    const discord = makeDiscord();
    engine = new WorkflowEngine({
      db,
      registry,
      executors: [new DiscordMessageExecutor({ getDiscord: () => discord, getOwnerId: () => "OWNER" })],
    });
    registry.register({
      name: "wf",
      steps: [{ name: "notify", type: "discord_message", message: "hi", userId: "USER7" }],
    });

    await engine.runWorkflow("wf");
    expect(discord.sendDM).toHaveBeenCalledWith("USER7", "hi");
  });

  it("fails the run when Discord isn't connected", async () => {
    engine = new WorkflowEngine({
      db,
      registry,
      executors: [new DiscordMessageExecutor({ getDiscord: () => undefined, getOwnerId: () => "OWNER" })],
    });
    registry.register({
      name: "wf",
      steps: [{ name: "notify", type: "discord_message", message: "x" }],
    });

    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("failed");
    expect(run.error).toContain("not connected");
  });

  it("fails with a clear error when neither target nor owner is configured", async () => {
    const discord = makeDiscord();
    engine = new WorkflowEngine({
      db,
      registry,
      executors: [new DiscordMessageExecutor({ getDiscord: () => discord, getOwnerId: () => undefined })],
    });
    registry.register({
      name: "wf",
      steps: [{ name: "notify", type: "discord_message", message: "x" }],
    });

    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("failed");
    expect(run.error).toContain("no channelId or userId");
  });
});
