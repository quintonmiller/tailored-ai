import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentRuntime,
  CronScheduler,
  WorkflowEngine,
  initDatabase,
  listWorkflowRuns,
  type AgentConfig,
  type AIProvider,
  type StepExecutor,
} from "../index.js";

class EchoExecutor implements StepExecutor {
  type = "shell" as const;
  received: unknown[] = [];
  async execute(step: { command?: string }, ctx: { scope: { input: unknown } }) {
    this.received.push(ctx.scope.input);
    return { output: String(step.command ?? "ok") };
  }
}

function fakeProvider(): AIProvider {
  return {
    id: "fake",
    name: "fake",
    supportsTools: true,
    chat: async () => ({
      content: "ok",
      usage: { input: 0, output: 0 },
      finishReason: "stop",
    }),
  };
}

function buildConfig(jobs: AgentConfig["cron"]["jobs"]): AgentConfig {
  return {
    server: { port: 0, host: "x" },
    database: { path: ":memory:" },
    providers: { ollama: { baseUrl: "x", defaultModel: "fake" } },
    agent: {
      defaultProvider: "ollama",
      extraInstructions: "",
      maxHistoryTokens: 100,
      maxContextTokens: 4096,
      temperature: 0.3,
      maxToolRounds: 1,
    },
    agents: {},
    cron: { enabled: true, jobs },
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

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wf-cron-"));
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("cron trigger -> workflow", () => {
  it("invokes workflowEngine.runWorkflow with a workflow input bundle", async () => {
    const cfg = buildConfig([
      {
        name: "nightly",
        schedule: "0 0 * * *",
        prompt: "Compile a digest for ${last_run}",
        workflow: "digest",
      },
    ]);
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
    const exec = new EchoExecutor();
    const engine = new WorkflowEngine({
      db,
      registry: runtime.getWorkflows(),
      executors: [exec],
    });
    runtime.registerWorkflow({
      name: "digest",
      steps: [{ name: "compile", type: "shell", command: "compiled" }],
    });

    const scheduler = new CronScheduler({ runtime, workflowEngine: engine });
    // Invoke the private runJob via a public path: just call runWorkflowJob through a small bridge.
    // The simplest is to use the scheduler's testRun helper if it existed; since it doesn't,
    // we exercise via the engine directly by mirroring the cron job path.
    await (scheduler as unknown as { runWorkflowJob: (j: unknown) => Promise<void> }).runWorkflowJob(cfg.cron.jobs[0]);

    expect(exec.received).toHaveLength(1);
    const input = exec.received[0] as Record<string, unknown>;
    expect(input.job_name).toBe("nightly");
    expect(typeof input.prompt).toBe("string");
    expect(input.prompt).toMatch(/Compile a digest for/);
    const runs = listWorkflowRuns(db);
    expect(runs[0].trigger).toBe("cron");
    expect(runs[0].status).toBe("completed");
  });

  it("warns and no-ops when the named workflow is not registered", async () => {
    const cfg = buildConfig([
      {
        name: "broken",
        schedule: "0 0 * * *",
        prompt: "x",
        workflow: "ghost",
      },
    ]);
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
    const engine = new WorkflowEngine({
      db,
      registry: runtime.getWorkflows(),
      executors: [new EchoExecutor()],
    });
    const scheduler = new CronScheduler({ runtime, workflowEngine: engine });
    await (scheduler as unknown as { runWorkflowJob: (j: unknown) => Promise<void> }).runWorkflowJob(cfg.cron.jobs[0]);
    expect(listWorkflowRuns(db)).toHaveLength(0);
  });
});
