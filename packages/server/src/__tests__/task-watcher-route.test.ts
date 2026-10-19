/**
 * `GET /api/task-watcher`: whether a change to a task wakes its agent, as the
 * watcher runs now, so the 3D world's task card can say so before you assign.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentConfig, AgentRuntime, type AIProvider, initDatabase, TaskWatcher } from "@tailored-ai/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../index.js";

function fakeProvider(): AIProvider {
  return {
    id: "fake",
    name: "fake",
    supportsTools: true,
    chat: async () => ({ content: "ok", usage: { input: 0, output: 0 }, finishReason: "stop" }),
  };
}

function buildConfig(): AgentConfig {
  return {
    server: { port: 0, host: "127.0.0.1" },
    database: { path: ":memory:" },
    providers: { openai_compatible: { baseUrl: "x", defaultModel: "fake" } },
    agent: {
      defaultProvider: "openai_compatible",
      extraInstructions: "",
      maxHistoryTokens: 100,
      maxContextTokens: 4096,
      temperature: 0.3,
      maxToolRounds: 1,
    },
    agents: {},
    cron: { enabled: false, jobs: [] },
    context: { directory: "./data/context", kbDirectory: "./data/kb" },
    channels: {},
    tools: {},
    taskWatcher: { enabled: false, prompt: "", debounceMs: 5000, triggers: ["created", "updated"] },
    webhooks: { enabled: false, routes: [] },
    custom_tools: {},
    commands: {},
  };
}

let db: ReturnType<typeof initDatabase>;
let runtime: AgentRuntime;
let cfg: AgentConfig;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "task-watcher-route-"));
  db = initDatabase(":memory:");
  cfg = buildConfig();
  const configPath = join(tmpDir, "config.yaml");
  writeFileSync(configPath, "", "utf-8");
  runtime = new AgentRuntime(
    {
      configPath,
      db,
      contextDir: join(tmpDir, "context"),
      kbDir: join(tmpDir, "kb"),
      createTools: () => [],
      createProvider: () => ({ provider: fakeProvider(), model: "fake" }),
    },
    () => cfg,
    cfg,
  );
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function watcherState(app: ReturnType<typeof createServer>["app"]) {
  const res = await app.fetch(new Request("http://t/api/task-watcher"));
  return { status: res.status, body: await res.json() };
}

describe("GET /api/task-watcher", () => {
  it("says the watcher is on, and what it reacts to, when it runs and is switched on", async () => {
    cfg.taskWatcher.enabled = true;
    const { app } = createServer({ runtime, taskWatcher: new TaskWatcher({ runtime }) });
    expect(await watcherState(app)).toEqual({ status: 200, body: { enabled: true, triggers: ["created", "updated"] } });
  });

  it("says it is off when it is switched off, or when none runs", async () => {
    const { app } = createServer({ runtime, taskWatcher: new TaskWatcher({ runtime }) });
    expect((await watcherState(app)).body.enabled).toBe(false);
    cfg.taskWatcher.enabled = true;
    const { app: bare } = createServer({ runtime });
    expect((await watcherState(bare)).body.enabled).toBe(false);
  });
});
