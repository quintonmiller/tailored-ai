import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AgentRuntime,
  WorkflowEngine,
  initDatabase,
  type AgentConfig,
  type AIProvider,
  type StepContext,
  type StepExecutor,
  type StepResult,
  type WorkflowStepDef,
} from "@agent/core";
import { createServer } from "../index.js";

class EchoExec implements StepExecutor {
  type = "shell" as const;
  async execute(step: WorkflowStepDef): Promise<StepResult> {
    return { output: `out:${step.name}` };
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

function buildConfig(): AgentConfig {
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
    webhooks: { enabled: false, routes: [] },
    custom_tools: {},
    commands: {},
  };
}

let db: ReturnType<typeof initDatabase>;
let runtime: AgentRuntime;
let engine: WorkflowEngine;
let app: ReturnType<typeof createServer>["app"];
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wf-routes-"));
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
  engine = new WorkflowEngine({
    db,
    registry: runtime.getWorkflows(),
    executors: [new EchoExec()],
  });
  runtime.registerWorkflow({
    name: "demo",
    description: "demo flow",
    steps: [{ name: "go", type: "shell", command: "echo hi" }],
  });
  app = createServer({ runtime, workflowEngine: engine }).app;
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function call(method: string, path: string, body?: unknown) {
  const res = await app.fetch(
    new Request(`http://t${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json };
}

describe("workflow HTTP routes", () => {
  it("GET /api/workflows lists registered workflows", async () => {
    const res = await call("GET", "/api/workflows");
    expect(res.status).toBe(200);
    const body = res.body as { workflows: Array<{ name: string }> };
    expect(body.workflows.map((w) => w.name)).toContain("demo");
  });

  it("GET /api/workflows/:name returns the definition", async () => {
    const res = await call("GET", "/api/workflows/demo");
    expect(res.status).toBe(200);
    const body = res.body as { name: string; steps: unknown[] };
    expect(body.name).toBe("demo");
    expect(body.steps).toHaveLength(1);
  });

  it("GET /api/workflows/:name returns 404 for unknown", async () => {
    const res = await call("GET", "/api/workflows/missing");
    expect(res.status).toBe(404);
  });

  it("POST /api/workflows/:name/run starts a run and returns 202", async () => {
    const res = await call("POST", "/api/workflows/demo/run", { input: { who: "tester" } });
    expect(res.status).toBe(202);
    const body = res.body as { id: string; status: string };
    expect(body.id).toMatch(/^wfrun_/);
    // Wait for completion via polling the run row.
    await new Promise((r) => setTimeout(r, 30));
    const fetched = await call("GET", `/api/workflow-runs/${body.id}`);
    expect(fetched.status).toBe(200);
    const detail = fetched.body as { run: { status: string }; steps: unknown[] };
    expect(detail.run.status).toBe("completed");
    expect(detail.steps).toHaveLength(1);
  });

  it("POST /api/workflows/:name/run 404s on unknown workflow", async () => {
    const res = await call("POST", "/api/workflows/ghost/run", {});
    expect(res.status).toBe(404);
  });

  it("GET /api/workflow-runs lists recent runs", async () => {
    await call("POST", "/api/workflows/demo/run");
    await new Promise((r) => setTimeout(r, 20));
    const res = await call("GET", "/api/workflow-runs");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect((res.body as Array<unknown>).length).toBeGreaterThan(0);
  });

  it("POST /api/workflow-runs/:id/cancel cancels a run", async () => {
    // Use a slow executor so we can cancel mid-run.
    const slow: StepExecutor = {
      type: "shell",
      async execute(_step: WorkflowStepDef, ctx: StepContext) {
        await new Promise<void>((resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(new Error("aborted")));
          setTimeout(resolve, 500);
        });
        return { output: "done" };
      },
    };
    engine.registerExecutor(slow);
    const startRes = await call("POST", "/api/workflows/demo/run");
    const startId = (startRes.body as { id: string }).id;
    const cancelRes = await call("POST", `/api/workflow-runs/${startId}/cancel`);
    expect(cancelRes.status).toBe(200);
    expect((cancelRes.body as { ok: boolean }).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    const detail = await call("GET", `/api/workflow-runs/${startId}`);
    expect(["cancelled", "failed"]).toContain((detail.body as { run: { status: string } }).run.status);
  });

  it("returns 503 when workflow engine is not configured", async () => {
    const noEngineApp = createServer({ runtime }).app;
    const res = await noEngineApp.fetch(
      new Request("http://t/api/workflows/demo/run", { method: "POST" }),
    );
    expect(res.status).toBe(503);
  });
});
