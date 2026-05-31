import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentConfig, AgentRuntime, type AIProvider, initDatabase } from "@tailored-ai/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { createServer } from "../index.js";

function fakeProvider(): AIProvider {
  return {
    id: "fake",
    name: "fake",
    supportsTools: true,
    chat: async () => ({ content: "ok", usage: { input: 0, output: 0 }, finishReason: "stop" }),
  };
}

function buildConfig(serverOverrides: Partial<AgentConfig["server"]>): AgentConfig {
  return {
    server: { port: 0, host: "127.0.0.1", ...serverOverrides },
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
let tmpDir: string;
let originalCwd: string;
let originalHome: string | undefined;

function bootApp(cfg: AgentConfig) {
  const configPath = join(tmpDir, "config.yaml");
  writeFileSync(configPath, YAML.stringify({}), "utf-8");
  const runtime = new AgentRuntime(
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
  return createServer({ runtime }).app;
}

async function callRaw(
  app: ReturnType<typeof bootApp>,
  method: string,
  path: string,
  headers: Record<string, string> = {},
) {
  const res = await app.fetch(new Request(`http://t${path}`, { method, headers }));
  return { status: res.status, text: await res.text() };
}

beforeEach(() => {
  originalCwd = process.cwd();
  originalHome = process.env.HOME;
  tmpDir = mkdtempSync(join(tmpdir(), "auth-token-"));
  process.env.HOME = tmpDir;
  process.chdir(tmpDir);
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("server.authToken", () => {
  it("when unset, GET /api/health is reachable without auth", async () => {
    const app = bootApp(buildConfig({}));
    const r = await callRaw(app, "GET", "/api/health");
    expect(r.status).toBe(200);
  });

  it("when set, GET requires a matching bearer", async () => {
    const app = bootApp(buildConfig({ authToken: "secret-token" }));

    const noAuth = await callRaw(app, "GET", "/api/health");
    expect(noAuth.status).toBe(401);

    const wrongAuth = await callRaw(app, "GET", "/api/health", {
      Authorization: "Bearer nope",
    });
    expect(wrongAuth.status).toBe(401);

    const goodAuth = await callRaw(app, "GET", "/api/health", {
      Authorization: "Bearer secret-token",
    });
    expect(goodAuth.status).toBe(200);
  });

  it("when set, mutating verbs also require the bearer", async () => {
    const app = bootApp(buildConfig({ authToken: "secret-token" }));
    const noAuth = await callRaw(app, "POST", "/api/sessions/foo/clear");
    expect(noAuth.status).toBe(401);

    const goodAuth = await callRaw(app, "POST", "/api/sessions/foo/clear", {
      Authorization: "Bearer secret-token",
    });
    expect(goodAuth.status).not.toBe(401);
  });

  it("OPTIONS passes through without bearer (CORS preflight)", async () => {
    const app = bootApp(buildConfig({ authToken: "secret-token" }));
    const r = await callRaw(app, "OPTIONS", "/api/health");
    expect(r.status).not.toBe(401);
  });
});

describe("server.apiKey (legacy)", () => {
  it("when set without authToken, GETs are still open", async () => {
    const app = bootApp(buildConfig({ apiKey: "legacy-key" }));
    const r = await callRaw(app, "GET", "/api/health");
    expect(r.status).toBe(200);
  });

  it("when set without authToken, mutating verbs require the bearer", async () => {
    const app = bootApp(buildConfig({ apiKey: "legacy-key" }));
    const noAuth = await callRaw(app, "POST", "/api/sessions/foo/clear");
    expect(noAuth.status).toBe(401);

    const goodAuth = await callRaw(app, "POST", "/api/sessions/foo/clear", {
      Authorization: "Bearer legacy-key",
    });
    expect(goodAuth.status).not.toBe(401);
  });

  it("authToken takes precedence — apiKey is not checked", async () => {
    const app = bootApp(buildConfig({ apiKey: "legacy-key", authToken: "new-token" }));

    const legacyOnly = await callRaw(app, "POST", "/api/sessions/foo/clear", {
      Authorization: "Bearer legacy-key",
    });
    expect(legacyOnly.status).toBe(401);

    const newOnly = await callRaw(app, "POST", "/api/sessions/foo/clear", {
      Authorization: "Bearer new-token",
    });
    expect(newOnly.status).not.toBe(401);
  });
});
