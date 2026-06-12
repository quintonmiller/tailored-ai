import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentConfig,
  AgentRuntime,
  type AIProvider,
  type HttpRouteDescriptor,
  initDatabase,
} from "@tailored-ai/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { routePathToRegex } from "../http-routes.js";
import { createServer } from "../index.js";

function fakeProvider(): AIProvider {
  return {
    id: "fake",
    name: "fake",
    supportsTools: true,
    chat: async () => ({ content: "ok", usage: { input: 0, output: 0 }, finishReason: "stop" }),
  };
}

function buildConfig(serverOverrides: Partial<AgentConfig["server"]> = {}): AgentConfig {
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
  } as unknown as AgentConfig;
}

let db: ReturnType<typeof initDatabase>;
let tmpDir: string;
let originalCwd: string;
let originalHome: string | undefined;

function makeRuntime(cfg: AgentConfig): AgentRuntime {
  const configPath = join(tmpDir, "config.yaml");
  writeFileSync(configPath, YAML.stringify({}), "utf-8");
  return new AgentRuntime(
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
}

async function call(app: ReturnType<typeof createServer>["app"], method: string, path: string, init: RequestInit = {}) {
  const res = await app.fetch(new Request(`http://t${path}`, { method, ...init }));
  return { status: res.status, text: await res.text() };
}

beforeEach(() => {
  originalCwd = process.cwd();
  originalHome = process.env.HOME;
  tmpDir = mkdtempSync(join(tmpdir(), "plugin-http-"));
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

describe("routePathToRegex", () => {
  it("matches a static path exactly", () => {
    const re = routePathToRegex("/api/trusted-actions/callback");
    expect(re.test("/api/trusted-actions/callback")).toBe(true);
    expect(re.test("/api/trusted-actions/callbackx")).toBe(false);
    expect(re.test("/api/trusted-actions")).toBe(false);
  });

  it("matches a :param segment as a single non-slash segment", () => {
    const re = routePathToRegex("/api/ext/jobs/items/:id/run");
    expect(re.test("/api/ext/jobs/items/abc/run")).toBe(true);
    expect(re.test("/api/ext/jobs/items/abc/def/run")).toBe(false);
  });
});

describe("plugin HTTP routes mounted on Hono", () => {
  it("mounts a namespaced route and reaches the handler", async () => {
    const runtime = makeRuntime(buildConfig());
    const route: HttpRouteDescriptor = {
      method: "GET",
      path: "ping",
      handler: async () => ({ status: 200, json: { pong: true } }),
    };
    runtime.getHttpRoutes().register(route, "demo");
    const { app } = createServer({ runtime });
    const r = await call(app, "GET", "/api/ext/demo/ping");
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ pong: true });
  });

  it("passes params, query, and JSON body into the handler", async () => {
    const runtime = makeRuntime(buildConfig());
    runtime.getHttpRoutes().register(
      {
        method: "POST",
        path: "echo/:id",
        handler: async (req) => ({
          status: 200,
          json: { id: req.params.id, q: req.query.q, body: await req.json() },
        }),
      },
      "demo",
    );
    const { app } = createServer({ runtime });
    const r = await call(app, "POST", "/api/ext/demo/echo/42?q=hi", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ id: "42", q: "hi", body: { a: 1 } });
  });

  it("applies the server authToken gate to token routes (default)", async () => {
    const runtime = makeRuntime(buildConfig({ authToken: "secret" }));
    runtime
      .getHttpRoutes()
      .register({ method: "GET", path: "guarded", handler: async () => ({ status: 200 }) }, "demo");
    const { app } = createServer({ runtime });

    const noAuth = await call(app, "GET", "/api/ext/demo/guarded");
    expect(noAuth.status).toBe(401);

    const good = await call(app, "GET", "/api/ext/demo/guarded", { headers: { Authorization: "Bearer secret" } });
    expect(good.status).toBe(200);
  });

  it("exempts auth:'none' routes from the server bearer check", async () => {
    const runtime = makeRuntime(buildConfig({ authToken: "secret" }));
    // Under /api/ so the `/api/*` auth middleware runs and must skip it.
    runtime.getHttpRoutes().register({
      method: "POST",
      path: "/api/inbound/hook",
      absolute: true,
      auth: "none",
      handler: async () => ({ status: 200, json: { received: true } }),
    });
    // A sibling token route confirms the gate is otherwise live.
    runtime.getHttpRoutes().register({
      method: "POST",
      path: "/api/inbound/guarded",
      absolute: true,
      handler: async () => ({ status: 200, json: { received: true } }),
    });
    const { app } = createServer({ runtime });

    // No bearer — would 401 for a token route, but this one is exempt.
    const exempt = await call(app, "POST", "/api/inbound/hook");
    expect(exempt.status).toBe(200);
    expect(JSON.parse(exempt.text)).toEqual({ received: true });

    // The sibling token route still 401s without a bearer.
    const guarded = await call(app, "POST", "/api/inbound/guarded");
    expect(guarded.status).toBe(401);
  });
});
