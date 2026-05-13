/**
 * End-to-end integration tests across step types. Exercises composition
 * patterns that the focused per-slice tests don't cover by themselves:
 * loop containing parallel containing conditions; YAML loading driving
 * a real run; multi-trigger paths sharing one engine.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentRunExecutor,
  AgentRuntime,
  LoopExecutor,
  ParallelExecutor,
  ShellExecutor,
  ToolCallExecutor,
  WorkflowEngine,
  WorkflowRegistry,
  initDatabase,
  listWorkflowRuns,
  listWorkflowSteps,
  loadWorkflowsFromDir,
  type AgentConfig,
  type AIProvider,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "../index.js";

class TallyTool implements Tool {
  name: string;
  description = "tally";
  parameters = {};
  calls: Array<{ args: Record<string, unknown>; sessionId: string }> = [];
  output: string;
  constructor(name: string, output = "tallied") {
    this.name = name;
    this.output = output;
  }
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    this.calls.push({ args, sessionId: ctx.sessionId });
    return { success: true, output: this.output };
  }
}

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
    server: { port: 0, host: "x" },
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
    agents: { researcher: { instructions: "" }, writer: { instructions: "" } },
    cron: { enabled: false, jobs: [] },
    context: { directory: "./data/context", kbDirectory: "./data/kb" },
    channels: {},
    tools: {},
    taskWatcher: { enabled: false, prompt: "", debounceMs: 5000, triggers: [] },
    webhooks: { enabled: false, routes: [] },
    custom_tools: {},
    commands: {},
  };
}

let tmp: string;
let db: Database.Database;
let runtime: AgentRuntime;
let engine: WorkflowEngine;
let tools: Tool[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "wf-integ-"));
  db = initDatabase(":memory:");
  const cfg = buildConfig();
  runtime = new AgentRuntime(
    {
      configPath: join(tmp, "config.yaml"),
      db,
      contextDir: join(tmp, "context"),
      kbDir: join(tmp, "kb"),
      createTools: () => tools,
      createProvider: () => ({ provider: fakeProvider(), model: "fake" }),
    },
    () => cfg,
    cfg,
  );
  tools = [];
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function makeEngine(opts: { runLoop?: (prompt: string) => Promise<string> } = {}): WorkflowEngine {
  const e = new WorkflowEngine({
    db,
    registry: runtime.getWorkflows(),
    executors: [
      new AgentRunExecutor({
        runtime,
        db,
        runAgentLoop: opts.runLoop ? async (prompt) => opts.runLoop!(prompt) : async () => "ok",
      }),
      new ToolCallExecutor({ getTools: () => tools }),
      new ShellExecutor({ cwd: tmp, defaultTimeoutMs: 5000 }),
      new LoopExecutor(),
      new ParallelExecutor(),
    ],
  });
  runtime.setWorkflowEngine(e);
  return e;
}

describe("integration — composition", () => {
  it("loop containing parallel containing condition + shell threads outputs end-to-end", async () => {
    engine = makeEngine();
    runtime.registerWorkflow({
      name: "compose",
      steps: [
        {
          name: "per-item",
          type: "loop",
          over: "${input.items}",
          as: "item",
          body: [
            {
              name: "branch",
              type: "condition",
              if: "${item.kind} == \"big\"",
              then: ["small-only"],
              else: ["big-only"],
            },
            { name: "big-only", type: "shell", command: "echo BIG ${item.id}" },
            { name: "small-only", type: "shell", command: "echo small ${item.id}" },
            {
              name: "fanout",
              type: "parallel",
              steps: [
                { name: "stamp", type: "shell", command: "echo stamped" },
                { name: "log", type: "shell", command: "echo logged-${item.id}" },
              ],
            },
          ],
        },
      ],
    });

    const run = await engine.runWorkflow("compose", {
      items: [
        { id: 1, kind: "big" },
        { id: 2, kind: "small" },
      ],
    });
    expect(run.status).toBe("completed");
    const outputs = run.output as unknown[];
    expect(outputs).toHaveLength(2);
    const first = outputs[0] as { stamp: string; log: string };
    expect(first.log.trim()).toBe("logged-1");
    const second = outputs[1] as { stamp: string; log: string };
    expect(second.log.trim()).toBe("logged-2");
    // Check the loop+condition recorded both branches' status correctly.
    const steps = listWorkflowSteps(db, run.id);
    const bigOnlyStatuses = steps.filter((s) => s.step_name === "big-only").map((s) => s.status);
    const smallOnlyStatuses = steps.filter((s) => s.step_name === "small-only").map((s) => s.status);
    // Two iterations: one runs big-only/skips small-only, the other inverts.
    expect(bigOnlyStatuses.sort()).toEqual(["completed", "skipped"]);
    expect(smallOnlyStatuses.sort()).toEqual(["completed", "skipped"]);
  });

  it("agent_run -> tool_call -> shell pipeline threads outputs through scope", async () => {
    const writeTool = new TallyTool("publish", "published-true");
    tools = [writeTool];
    runtime.reload(); // refresh tools cache
    engine = makeEngine({
      runLoop: async (prompt) => `summary-of(${prompt})`,
    });
    runtime.registerWorkflow({
      name: "pipeline",
      steps: [
        {
          name: "summarize",
          type: "agent_run",
          agent: "researcher",
          prompt: "Summarize ${input.url}",
        },
        {
          name: "publish",
          type: "tool_call",
          tool: "publish",
          args: { content: "${steps.summarize}" },
        },
        {
          name: "verify",
          type: "shell",
          command: "echo verified:${steps.publish}",
        },
      ],
    });
    const run = await engine.runWorkflow("pipeline", { url: "https://x" });
    expect(run.status).toBe("completed");
    expect(String(run.output).trim()).toBe("verified:published-true");
    expect(writeTool.calls).toHaveLength(1);
    expect(writeTool.calls[0].args.content).toBe("summary-of(Summarize https://x)");
    expect(writeTool.calls[0].sessionId).toMatch(/^workflow:wfrun_/);
  });
});

describe("integration — YAML loader -> engine", () => {
  it("loads a YAML workflow from disk and runs it through the engine", async () => {
    const workflowsDir = join(tmp, "workflows");
    writeFileSync(
      join(tmp, "config.yaml"),
      "# test\n",
    );
    mkdirSync(workflowsDir);
    writeFileSync(
      join(workflowsDir, "yaml-test.yaml"),
      `name: yaml-test
steps:
  - name: say
    type: shell
    command: echo hello-\${input.who}
`,
    );

    // Reload registry to discover the file.
    runtime.getWorkflows().setDirectory(workflowsDir);
    runtime.getWorkflows().reloadFromDisk();
    expect(runtime.getWorkflows().get("yaml-test")?.source).toBe(workflowsDir);

    engine = makeEngine();
    const run = await engine.runWorkflow("yaml-test", { who: "yamlworld" });
    expect(run.status).toBe("completed");
    expect(String(run.output).trim()).toBe("hello-yamlworld");
  });

  it("loadWorkflowsFromDir surfaces parse + validation errors per file", () => {
    const dir = join(tmp, "wf-bad");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "good.yaml"),
      "name: good\nsteps:\n  - name: x\n    type: shell\n    command: echo\n",
    );
    writeFileSync(join(dir, "bad.yaml"), "name: bad\nsteps: []\n");

    const result = loadWorkflowsFromDir(dir);
    expect(result.workflows.map((w) => w.name)).toEqual(["good"]);
    expect(result.errors.map((e) => e.path.endsWith("bad.yaml")).every(Boolean)).toBe(true);
  });
});

describe("integration — engine event stream during a run", () => {
  it("emits run + step events in chronological order", async () => {
    engine = makeEngine();
    runtime.registerWorkflow({
      name: "events",
      steps: [
        { name: "a", type: "shell", command: "echo a" },
        { name: "b", type: "shell", command: "echo b" },
      ],
    });
    const events: string[] = [];
    engine.onEvent((e) => {
      if ("stepName" in e) events.push(`${e.type}:${e.stepName}`);
      else events.push(e.type);
    });
    await engine.runWorkflow("events");
    expect(events).toEqual([
      "run.started",
      "step.started:a",
      "step.completed:a",
      "step.started:b",
      "step.completed:b",
      "run.completed",
    ]);
  });
});

describe("integration — engine cancellation + restart sweep", () => {
  it("orphaned runs from an earlier process are marked interrupted on startup", async () => {
    engine = makeEngine();
    runtime.registerWorkflow({
      name: "stays",
      steps: [
        { name: "block", type: "shell", command: "x" } as never,
      ],
    });
    // Manually create a row in 'running' state to simulate a crash.
    db.prepare(
      "INSERT INTO workflow_runs (id, workflow_name, status, trigger, input_json) VALUES (?, ?, ?, ?, ?)",
    ).run("wfrun_stuck111", "stays", "running", "http", "{}");
    db.prepare(
      "INSERT INTO workflow_runs (id, workflow_name, status, trigger, input_json) VALUES (?, ?, ?, ?, ?)",
    ).run("wfrun_pending1", "stays", "pending", "http", "{}");

    const promoted = WorkflowEngine.promoteOrphanedRuns(db);
    expect(promoted).toBe(2);

    const stuck = listWorkflowRuns(db, { workflow_name: "stays" });
    expect(stuck.every((r) => r.status === "interrupted")).toBe(true);
    expect(stuck.every((r) => r.finished_at !== null)).toBe(true);
  });
});
