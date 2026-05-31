import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentConfig,
  AgentRuntime,
  type AIProvider,
  AutopilotWorker,
  createProjectTask,
  getProjectTask,
  initDatabase,
  NativeTaskBackend,
  type StepContext,
  type StepExecutor,
  type StepResult,
  updateProjectTask,
  WorkflowEngine,
  type WorkflowStepDef,
} from "../index.js";

class CaptureExec implements StepExecutor {
  type = "shell" as const;
  inputs: unknown[] = [];
  async execute(step: WorkflowStepDef, ctx: StepContext): Promise<StepResult> {
    this.inputs.push(ctx.scope.input);
    return { output: `out:${(step as { command: string }).command}` };
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
    agents: { default: { instructions: "" } },
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

let tmpDir: string;
let db: Database.Database;
let runtime: AgentRuntime;
let engine: WorkflowEngine;
let exec: CaptureExec;
let worker: AutopilotWorker;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wf-autopilot-"));
  db = initDatabase(":memory:");
  const cfg = buildConfig();
  runtime = new AgentRuntime(
    {
      configPath: join(tmpDir, "config.yaml"),
      db,
      contextDir: join(tmpDir, "context"),
      kbDir: join(tmpDir, "kb"),
      createTools: () => [],
      createProvider: () => ({ provider: fakeProvider(), model: "fake" }),
    },
    () => cfg,
    cfg,
  );
  exec = new CaptureExec();
  engine = new WorkflowEngine({
    db,
    registry: runtime.getWorkflows(),
    executors: [exec],
  });
  runtime.setWorkflowEngine(engine);
  runtime.registerWorkflow({
    name: "review",
    steps: [{ name: "go", type: "shell", command: "reviewed" }],
  });
  worker = new AutopilotWorker({
    runtime,
    taskBackend: new NativeTaskBackend(db),
  });
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("autopilot -> workflow trigger", () => {
  it("routes a task tagged workflow:<name> through the engine instead of the agent loop", async () => {
    const created = createProjectTask(db, {
      title: "review the PR",
      assignee: "default",
      tags: ["workflow:review", "size:m"],
    });
    // Simulate the claim transition so finalizeTask can post its summary
    // comment (it only fires when status is in_progress at finalize time).
    updateProjectTask(db, created.id, { status: "in_progress" });
    const task = getProjectTask(db, created.id)!;

    await (worker as unknown as { runTask: (t: unknown) => Promise<void> }).runTask(task);

    expect(exec.inputs).toHaveLength(1);
    const input = exec.inputs[0] as { task: { id: string; title: string }; agent: string | null };
    expect(input.task.id).toBe(task.id);
    expect(input.task.title).toBe("review the PR");
    expect(input.agent).toBe("default");

    const comments = db
      .prepare("SELECT content FROM task_comments WHERE task_id = ? ORDER BY id ASC")
      .all(task.id) as Array<{ content: string }>;
    expect(comments.length).toBeGreaterThan(0);
    expect(comments[0].content).toContain("out:reviewed");

    // Task transitioned to done after the workflow finished.
    expect(getProjectTask(db, task.id)?.status).toBe("done");
  });

  it("falls back to agent loop when the named workflow is not registered", async () => {
    const task = createProjectTask(db, {
      title: "no workflow",
      assignee: "default",
      tags: ["workflow:ghost"],
    });
    const fallback = vi.spyOn(
      worker as unknown as { resolveSessionModel: (n: string) => Promise<{ provider: string; model: string }> },
      "resolveSessionModel",
    );
    fallback.mockResolvedValue({ provider: "openai_compatible", model: "fake" });
    // Will fall back to runAgentLoop path but our runtime.getProvider returns
    // a fake; we only care that the workflow path was NOT taken.
    try {
      await (worker as unknown as { runTask: (t: unknown) => Promise<void> }).runTask({
        ...task,
        tags: ["workflow:ghost"],
      });
    } catch {
      // The agent-loop path may throw inside our test stub. Either way, the
      // workflow exec should NOT have been invoked.
    }
    expect(exec.inputs).toHaveLength(0);
  });
});
