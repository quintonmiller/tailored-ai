import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentRuntime,
  WorkflowEngine,
  initDatabase,
  listWorkflowRuns,
  type AgentConfig,
  type AIProvider,
  type StepExecutor,
  type StepResult,
  type WorkflowStepDef,
} from "@agent/core";
import { createServer } from "../index.js";

class CaptureExec implements StepExecutor {
  type = "shell" as const;
  inputs: unknown[] = [];
  async execute(
    step: WorkflowStepDef,
    ctx: import("@agent/core").StepContext,
  ): Promise<StepResult> {
    this.inputs.push(ctx.scope.input);
    return { output: String((step as { command: string }).command) };
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

function buildConfig(routes: AgentConfig["webhooks"]["routes"]): AgentConfig {
  return {
    server: { port: 0, host: "127.0.0.1" },
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
    cron: { enabled: false, jobs: [] },
    context: { directory: "./data/context", kbDirectory: "./data/kb" },
    channels: {},
    tools: {},
    taskWatcher: { enabled: false, prompt: "", debounceMs: 5000, triggers: [] },
    webhooks: { enabled: true, routes },
    custom_tools: {},
    commands: {},
  };
}

let tmpDir: string;
let db: ReturnType<typeof initDatabase>;
let runtime: AgentRuntime;
let engine: WorkflowEngine;
let app: ReturnType<typeof createServer>["app"];
let exec: CaptureExec;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wf-webhook-"));
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function setup(routes: AgentConfig["webhooks"]["routes"]) {
  const cfg = buildConfig(routes);
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
  runtime.registerWorkflow({
    name: "review",
    steps: [{ name: "go", type: "shell", command: "done" }],
  });
  app = createServer({ runtime, workflowEngine: engine }).app;
}

describe("webhook trigger -> workflow", () => {
  it("action: workflow invokes the named workflow with payload as input", async () => {
    setup([
      {
        path: "/pr",
        action: "workflow",
        workflow: "review",
        messageTemplate: "PR #{{pr.number}}: {{pr.title}}",
      },
    ]);
    const res = await app.fetch(
      new Request("http://t/api/webhooks/pr", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pr: { number: 42, title: "Add cool thing" } }),
      }),
    );
    expect([200, 202]).toContain(res.status);
    await new Promise((r) => setTimeout(r, 25));
    const runs = listWorkflowRuns(db);
    expect(runs).toHaveLength(1);
    expect(runs[0].trigger).toBe("webhook");
    expect(exec.inputs).toHaveLength(1);
    const input = exec.inputs[0] as { message: string; payload: { pr: { number: number } }; route: string };
    expect(input.message).toBe("PR #42: Add cool thing");
    expect(input.payload.pr.number).toBe(42);
    expect(input.route).toBe("pr");
  });

  it("returns 400 when action: workflow is set but workflow name is missing", async () => {
    setup([
      {
        path: "/x",
        action: "workflow",
        messageTemplate: "x",
      },
    ]);
    const res = await app.fetch(
      new Request("http://t/api/webhooks/x", { method: "POST" }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when the named workflow doesn't exist", async () => {
    setup([
      {
        path: "/x",
        action: "workflow",
        workflow: "missing",
        messageTemplate: "x",
      },
    ]);
    const res = await app.fetch(
      new Request("http://t/api/webhooks/x", { method: "POST" }),
    );
    expect(res.status).toBe(404);
  });
});
