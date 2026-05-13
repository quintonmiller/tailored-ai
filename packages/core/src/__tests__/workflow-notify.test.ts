import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDatabase } from "../db/schema.js";
import { WorkflowEngine } from "../workflows/engine.js";
import { NotifyExecutor, type EmailSender } from "../workflows/executors/notify.js";
import type { DiscordSender } from "../workflows/executors/discord-message.js";
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

function fakeDiscord() {
  return {
    send: vi.fn(async () => {}),
    sendDM: vi.fn(async () => {}),
  } satisfies DiscordSender;
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
          getDiscord: () => undefined,
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

  it("discord channel falls back to owner DM when no target is set", async () => {
    const discord = fakeDiscord();
    const engine = new WorkflowEngine({
      db,
      registry,
      executors: [
        new NotifyExecutor({
          getDiscord: () => discord,
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
    expect(discord.sendDM).toHaveBeenCalledWith("owner123", "ping");
  });

  it("discord channel honours explicit channelId", async () => {
    const discord = fakeDiscord();
    const engine = new WorkflowEngine({
      db,
      registry,
      executors: [
        new NotifyExecutor({
          getDiscord: () => discord,
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
    expect(discord.send).toHaveBeenCalledWith("ch-1", "ping");
    expect(discord.sendDM).not.toHaveBeenCalled();
  });

  it("email channel dispatches through the configured sender", async () => {
    const email = fakeEmail();
    const engine = new WorkflowEngine({
      db,
      registry,
      executors: [
        new NotifyExecutor({
          getDiscord: () => undefined,
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
          getDiscord: () => undefined,
          getOwnerId: () => undefined,
        }),
      ],
    });
    registry.register({
      name: "wf",
      steps: [
        { name: "send", type: "notify", channel: "email", to: "a@x", message: "x" },
      ],
    });
    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/no email backend/);
  });
});
