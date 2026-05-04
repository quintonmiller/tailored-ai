import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDatabase } from "../db/schema.js";
import { listWorkflowSteps } from "../db/workflow-queries.js";
import type { AgentLoopOptions } from "../agent/loop.js";
import { AgentRuntime } from "../runtime.js";
import { WorkflowEngine } from "../workflows/engine.js";
import { AgentRunExecutor } from "../workflows/executors/agent-run.js";
import type { AgentConfig } from "../config.js";
import type { AIProvider } from "../providers/interface.js";

function fakeProvider(): AIProvider {
  return {
    id: "fake",
    name: "fake",
    supportsTools: true,
    chat: async () => ({
      content: "fake response",
      usage: { input: 0, output: 0 },
      finishReason: "stop",
    }),
  };
}

function buildConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    server: { port: 3000, host: "0.0.0.0" },
    database: { path: ":memory:" },
    providers: { ollama: { baseUrl: "http://x", defaultModel: "fake-model" } },
    agent: {
      defaultProvider: "ollama",
      extraInstructions: "",
      maxHistoryTokens: 2000,
      maxContextTokens: 4096,
      temperature: 0.3,
      maxToolRounds: 5,
    },
    agents: {
      researcher: {
        instructions: "research things",
        tools: [],
      },
      coder: {
        instructions: "code things",
        tools: [],
      },
    },
    cron: { enabled: false, jobs: [] },
    context: { directory: "./data/context", kbDirectory: "./data/kb" },
    channels: {},
    tools: {},
    taskWatcher: { enabled: false, prompt: "", debounceMs: 5000, triggers: [] },
    webhooks: { enabled: false, routes: [] },
    custom_tools: {},
    commands: {},
    ...overrides,
  };
}

let tmpDir: string;
let db: Database.Database;
let runtime: AgentRuntime;
let recordedRuns: Array<{ prompt: string; opts: AgentLoopOptions }> = [];

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wf-agent-"));
  db = initDatabase(":memory:");
  recordedRuns = [];
  const cfg = buildConfig();
  runtime = new AgentRuntime(
    {
      configPath: join(tmpDir, "config.yaml"),
      db,
      contextDir: join(tmpDir, "context"),
      kbDir: join(tmpDir, "kb"),
      createTools: () => [],
      createProvider: () => ({ provider: fakeProvider(), model: "fake-model" }),
    },
    () => cfg,
    cfg,
  );
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("AgentRunExecutor", () => {
  it("invokes the agent loop with a workflow-keyed session and returns its response", async () => {
    const runLoop = vi.fn(async (prompt: string, _opts: AgentLoopOptions) => {
      return `responded to: ${prompt}`;
    });
    const exec = new AgentRunExecutor({ runtime, db, runAgentLoop: runLoop });
    const engine = new WorkflowEngine({
      db,
      registry: runtime.getWorkflows(),
      executors: [exec],
    });
    runtime.registerWorkflow({
      name: "wf",
      steps: [
        {
          name: "step1",
          type: "agent_run",
          agent: "researcher",
          prompt: "Look up ${input.topic}",
        },
      ],
    });
    const run = await engine.runWorkflow("wf", { topic: "rust" });
    expect(run.status).toBe("completed");
    expect(run.output).toBe("responded to: Look up rust");
    expect(runLoop).toHaveBeenCalledTimes(1);
    const [calledPrompt, calledOpts] = runLoop.mock.calls[0];
    expect(calledPrompt).toBe("Look up rust");
    expect(calledOpts.session.id).toBeTruthy();
    expect(calledOpts.signal).toBeDefined();
  });

  it("threads outputs through ${steps.<name>}", async () => {
    const runLoop = vi.fn(async (prompt: string) => `ECHO[${prompt}]`);
    const engine = new WorkflowEngine({
      db,
      registry: runtime.getWorkflows(),
      executors: [new AgentRunExecutor({ runtime, db, runAgentLoop: runLoop })],
    });
    runtime.registerWorkflow({
      name: "wf",
      steps: [
        { name: "first", type: "agent_run", agent: "researcher", prompt: "what is X?" },
        {
          name: "second",
          type: "agent_run",
          agent: "coder",
          prompt: "summarize: ${steps.first}",
        },
      ],
    });
    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("completed");
    expect(run.output).toBe("ECHO[summarize: ECHO[what is X?]]");
  });

  it("rejects when the agent name is not in config", async () => {
    const engine = new WorkflowEngine({
      db,
      registry: runtime.getWorkflows(),
      executors: [
        new AgentRunExecutor({ runtime, db, runAgentLoop: async () => "nope" }),
      ],
    });
    runtime.registerWorkflow({
      name: "wf",
      steps: [{ name: "x", type: "agent_run", agent: "ghost", prompt: "hi" }],
    });
    const run = await engine.runWorkflow("wf");
    expect(run.status).toBe("failed");
    expect(run.error).toContain('"ghost"');
  });

  it("respects step.maxToolRounds override", async () => {
    let observedRounds: number | undefined;
    const runLoop = vi.fn(async (_p: string, opts: AgentLoopOptions) => {
      observedRounds = opts.maxToolRounds;
      return "ok";
    });
    const engine = new WorkflowEngine({
      db,
      registry: runtime.getWorkflows(),
      executors: [new AgentRunExecutor({ runtime, db, runAgentLoop: runLoop })],
    });
    runtime.registerWorkflow({
      name: "wf",
      steps: [
        {
          name: "x",
          type: "agent_run",
          agent: "researcher",
          prompt: "do",
          maxToolRounds: 99,
        },
      ],
    });
    await engine.runWorkflow("wf");
    expect(observedRounds).toBe(99);
  });

  it("acquires per-agent semaphore — only one agent_run for the same agent runs at a time", async () => {
    const inflight = new Set<string>();
    let maxObserved = 0;
    const runLoop = vi.fn(async (prompt: string) => {
      inflight.add(prompt);
      maxObserved = Math.max(maxObserved, inflight.size);
      await new Promise((r) => setTimeout(r, 30));
      inflight.delete(prompt);
      return `done:${prompt}`;
    });
    const engine = new WorkflowEngine({
      db,
      registry: runtime.getWorkflows(),
      executors: [new AgentRunExecutor({ runtime, db, runAgentLoop: runLoop })],
      maxConcurrent: 4,
      agentConcurrency: () => 1, // force serialization for any agent
    });
    runtime.registerWorkflow({
      name: "wf",
      steps: [{ name: "step", type: "agent_run", agent: "researcher", prompt: "${input.q}" }],
    });
    await Promise.all([
      engine.runWorkflow("wf", { q: "first" }),
      engine.runWorkflow("wf", { q: "second" }),
      engine.runWorkflow("wf", { q: "third" }),
    ]);
    expect(maxObserved).toBe(1);
    expect(runLoop).toHaveBeenCalledTimes(3);
  });

  it("records blocked_on while waiting on the per-agent semaphore", async () => {
    let resolveFirst: (() => void) | undefined;
    const runLoop = vi.fn(async () => {
      // First call holds the semaphore until released
      if (!resolveFirst) {
        await new Promise<void>((r) => {
          resolveFirst = r;
        });
      }
      return "ok";
    });
    const engine = new WorkflowEngine({
      db,
      registry: runtime.getWorkflows(),
      executors: [new AgentRunExecutor({ runtime, db, runAgentLoop: runLoop })],
      agentConcurrency: () => 1,
    });
    runtime.registerWorkflow({
      name: "wf",
      steps: [{ name: "step", type: "agent_run", agent: "coder", prompt: "do" }],
    });
    const a = engine.runWorkflow("wf");
    // Give a tick for the first run to acquire the semaphore
    await new Promise((r) => setTimeout(r, 10));
    const b = engine.runWorkflow("wf");
    await new Promise((r) => setTimeout(r, 10));

    // Inspect the steps for run B — its step should be blocked_on agent:coder
    const runs = (await Promise.race([
      Promise.resolve("waiting"),
    ])) as string;
    expect(runs).toBe("waiting");
    const allSteps = db
      .prepare("SELECT * FROM workflow_steps WHERE blocked_on IS NOT NULL")
      .all() as Array<{ blocked_on: string }>;
    expect(allSteps.some((s) => s.blocked_on === "agent:coder")).toBe(true);

    // Release first
    resolveFirst?.();
    await Promise.all([a, b]);

    // After release, no rows still flagged as blocked
    const stillBlocked = db
      .prepare("SELECT COUNT(*) as c FROM workflow_steps WHERE blocked_on IS NOT NULL")
      .get() as { c: number };
    expect(stillBlocked.c).toBe(0);

    // And both runs completed
    const results = await Promise.all([a, b]);
    expect(results.every((r) => r.status === "completed")).toBe(true);

    // Sanity check: at least 2 step rows exist
    const allRuns = await Promise.all([a, b]);
    expect(listWorkflowSteps(db, allRuns[0].id)).toHaveLength(1);
    expect(listWorkflowSteps(db, allRuns[1].id)).toHaveLength(1);
  });
});
