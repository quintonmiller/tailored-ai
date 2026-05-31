import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDatabase } from "../db/schema.js";
import { WorkflowEngine } from "../workflows/engine.js";
import { DiscordMessageExecutor } from "../workflows/executors/discord-message.js";
import { HttpRequestExecutor } from "../workflows/executors/http-request.js";
import { NotifyExecutor } from "../workflows/executors/notify.js";
import { ShellExecutor } from "../workflows/executors/shell.js";
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

describe("dry-run mode", () => {
  it("notify in dry-run logs instead of calling discord/email", async () => {
    const discordSend = vi.fn(async () => {});
    const emailSend = vi.fn(async () => {});
    const logs: string[] = [];

    const engine = new WorkflowEngine({
      db,
      registry,
      executors: [
        new NotifyExecutor({
          getDiscord: () => ({ send: discordSend, sendDM: discordSend }),
          getOwnerId: () => "owner",
          getEmail: () => ({ send: emailSend }),
          log: (m) => logs.push(m),
        }),
      ],
    });
    registry.register({
      name: "wf",
      steps: [
        { name: "n1", type: "notify", channel: "discord", message: "ping" },
        { name: "n2", type: "notify", channel: "email", to: "a@x", message: "yo" },
      ],
    });
    const run = await engine.runWorkflow("wf", {}, "programmatic", { dryRun: true });
    expect(run.status).toBe("completed");
    expect(discordSend).not.toHaveBeenCalled();
    expect(emailSend).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("dry-run") && l.includes("discord"))).toBe(true);
    expect(logs.some((l) => l.includes("dry-run") && l.includes("email"))).toBe(true);
  });

  it("http_request in dry-run skips mutating methods but lets GET fire", async () => {
    const fetched: string[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      fetched.push(`${init?.method ?? "GET"} ${url}`);
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    }) as unknown as typeof fetch;

    const engine = new WorkflowEngine({
      db,
      registry,
      executors: [new HttpRequestExecutor({ fetcher })],
    });
    registry.register({
      name: "wf",
      steps: [
        { name: "g", type: "http_request", url: "https://example.test/data" },
        { name: "p", type: "http_request", method: "POST", url: "https://example.test/create", body: { a: 1 } },
      ],
    });
    const run = await engine.runWorkflow("wf", {}, "programmatic", { dryRun: true });
    expect(run.status).toBe("completed");
    expect(fetched).toEqual(["GET https://example.test/data"]); // POST suppressed
  });

  it("shell in dry-run does not execute the command", async () => {
    const engine = new WorkflowEngine({
      db,
      registry,
      executors: [new ShellExecutor({ defaultTimeoutMs: 2000 })],
    });
    registry.register({
      name: "wf",
      steps: [{ name: "boom", type: "shell", command: "exit 42" }],
    });
    const run = await engine.runWorkflow("wf", {}, "programmatic", { dryRun: true });
    expect(run.status).toBe("completed");
    expect(String(run.output)).toContain("[dry-run]");
  });

  it("discord_message legacy step honours dry-run", async () => {
    const send = vi.fn(async () => {});
    const engine = new WorkflowEngine({
      db,
      registry,
      executors: [
        new DiscordMessageExecutor({
          getDiscord: () => ({ send, sendDM: send }),
          getOwnerId: () => "owner",
        }),
      ],
    });
    registry.register({
      name: "wf",
      steps: [{ name: "m", type: "discord_message", message: "hi" }],
    });
    const run = await engine.runWorkflow("wf", {}, "programmatic", { dryRun: true });
    expect(run.status).toBe("completed");
    expect(send).not.toHaveBeenCalled();
  });
});
