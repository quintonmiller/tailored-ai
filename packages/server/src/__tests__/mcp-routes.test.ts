import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentConfig, AgentRuntime, type AIProvider, initDatabase } from "@tailored-ai/core";
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
    taskWatcher: { enabled: false, prompt: "", debounceMs: 5000, triggers: [] },
    webhooks: { enabled: false, routes: [] },
    custom_tools: {},
    commands: {},
  };
}

let db: ReturnType<typeof initDatabase>;
let runtime: AgentRuntime;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mcp-routes-"));
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
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function get(app: ReturnType<typeof createServer>["app"], path: string) {
  const res = await app.fetch(new Request(`http://t${path}`));
  return { status: res.status, body: (await res.json()) as { servers: Array<Record<string, unknown>> } };
}

describe("GET /api/mcp (#249)", () => {
  it("returns an empty list when no mcpStatus getter is wired", async () => {
    const { app } = createServer({ runtime });
    const res = await get(app, "/api/mcp");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ servers: [] });
  });

  it("surfaces connected servers (sorted, with tool count + ISO connectedAt)", async () => {
    const at = Date.UTC(2026, 5, 12, 0, 0, 0);
    const { app } = createServer({
      runtime,
      mcpStatus: () => [
        { serverId: "zeta", tools: ["mcp_zeta_a"], connectedAt: at },
        { serverId: "github", tools: ["mcp_github_search", "mcp_github_create"], connectedAt: at },
      ],
    });
    const res = await get(app, "/api/mcp");
    expect(res.status).toBe(200);
    // Sorted by serverId.
    expect(res.body.servers.map((s) => s.serverId)).toEqual(["github", "zeta"]);
    expect(res.body.servers[0]).toMatchObject({
      serverId: "github",
      toolCount: 2,
      tools: ["mcp_github_search", "mcp_github_create"],
      connectedAt: new Date(at).toISOString(),
    });
  });
});
