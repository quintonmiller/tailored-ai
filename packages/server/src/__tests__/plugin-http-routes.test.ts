import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentConfig,
  AgentRuntime,
  type AIProvider,
  createPluginContext,
  createTools,
  type HttpRouteDescriptor,
  initDatabase,
  type LoadedPlugin,
  loadPlugins,
  type PluginContext,
} from "@tailored-ai/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

describe("plugin HTTP routes after the server is built", () => {
  it("serves a route registered later, and stops serving one deregistered", async () => {
    const runtime = makeRuntime(buildConfig());
    const { app } = createServer({ runtime });
    expect((await call(app, "GET", "/api/ext/demo/late")).status).toBe(404);

    const mountPath = runtime
      .getHttpRoutes()
      .register({ method: "GET", path: "late", handler: async () => ({ json: { late: true } }) }, "demo");
    const r = await call(app, "GET", "/api/ext/demo/late");
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ late: true });

    runtime.getHttpRoutes().deregister("GET", mountPath);
    const gone = await call(app, "GET", "/api/ext/demo/late");
    // Answered by the plugin mount itself, in the API's own shape, whatever is mounted after it.
    expect({ status: gone.status, body: JSON.parse(gone.text) }).toEqual({ status: 404, body: { error: "not_found" } });
  });

  it("answers HEAD off a GET route and hands a handler decoded params", async () => {
    const runtime = makeRuntime(buildConfig());
    const { app } = createServer({ runtime });
    runtime.getHttpRoutes().register(
      {
        method: "GET",
        path: "items/:id",
        handler: async (req) => ({ json: { id: req.params.id, method: req.method } }),
      },
      "demo",
    );

    // An encoded slash stays encoded through Hono's path decoding; the param is decoded, as `c.req.param()` does.
    const got = await call(app, "GET", "/api/ext/demo/items/a%2Fb%20c");
    expect(JSON.parse(got.text)).toEqual({ id: "a/b c", method: "GET" });
    // A bad escape is left as it came, and the good ones around it still decode.
    const bad = await call(app, "GET", "/api/ext/demo/items/a%2Fb%ZZ");
    expect(JSON.parse(bad.text)).toEqual({ id: "a/b%ZZ", method: "GET" });
    const head = await app.fetch(new Request("http://t/api/ext/demo/items/x", { method: "HEAD" }));
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("answers 404, not the web UI's page, for a plugin route that is gone", async () => {
    const ui = join(tmpDir, "ui");
    mkdirSync(ui);
    writeFileSync(join(ui, "index.html"), "<html>the app</html>");
    const runtime = makeRuntime(buildConfig());
    const { app } = createServer({ runtime, uiProvider: { id: "test", staticDir: ui } });
    const routes = runtime.getHttpRoutes();
    const namespaced = routes.register(
      { method: "GET", path: "gone", handler: async () => ({ json: "here" }) },
      "demo",
    );
    const absolute = routes.register({
      method: "GET",
      path: "/api/legacy/gone",
      absolute: true,
      handler: async () => ({ json: "here" }),
    });
    expect(JSON.parse((await call(app, "GET", "/api/ext/demo/gone")).text)).toBe("here");

    routes.deregister("GET", namespaced);
    routes.deregister("GET", absolute);

    for (const path of ["/api/ext/demo/gone", "/api/legacy/gone", "/api/ext/never-registered"]) {
      const r = await call(app, "GET", path);
      expect({ path, status: r.status, body: JSON.parse(r.text) }).toEqual({
        path,
        status: 404,
        body: { error: "not_found" },
      });
    }
    // Pages outside the API still get the app, for client-side routing.
    const page = await call(app, "GET", "/chat");
    expect(page.status).toBe(200);
    expect(page.text).toContain("the app");
  });

  it("leaves core routes to win over a plugin route at the same path", async () => {
    const runtime = makeRuntime(buildConfig());
    const { app } = createServer({ runtime });
    runtime
      .getHttpRoutes()
      .register({ method: "GET", path: "/api/tools", absolute: true, handler: async () => ({ json: "plugin" }) });
    const r = await call(app, "GET", "/api/tools");
    expect(JSON.parse(r.text)).toEqual([]);
  });
});

/**
 * Through `runtime.reload()`, with the host's plugin pass after it as the CLI
 * runs it, against one server built at the start: the routes and tools a
 * reload turns on, off or changes are what the server serves next.
 */
describe("a reload moves a runtime plugin's routes and tools on the running server", () => {
  let loaded: LoadedPlugin[] = [];

  beforeEach(() => {
    loaded = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    for (const p of loaded) await p.stop?.();
    vi.restoreAllMocks();
  });

  function probePlugin(ctx: PluginContext) {
    const greeting = String(ctx.config.greeting ?? "hi");
    ctx.tools.register("probe", () => [
      {
        name: "probe",
        description: `says ${greeting}`,
        parameters: { type: "object", properties: {} },
        execute: async () => ({ success: true, output: greeting }),
      } as never,
    ]);
    ctx.http.register({ method: "GET", path: "hello", handler: () => ({ json: { greeting } }) });
    // A webhook a service calls with its own secret, so it skips the bearer check.
    ctx.http.register({ method: "POST", path: "hook", auth: "none", handler: () => ({ json: { greeting } }) });
  }

  function withPlugin(plugin: Record<string, unknown>, server: Partial<AgentConfig["server"]> = {}): AgentConfig {
    return { ...buildConfig(server), plugins: [{ module: "probe-plugin", ...plugin }] } as unknown as AgentConfig;
  }

  async function boot(initial: AgentConfig) {
    let cfg = initial;
    const configPath = join(tmpDir, "config.yaml");
    writeFileSync(configPath, YAML.stringify({}), "utf-8");
    const runtime = new AgentRuntime(
      {
        configPath,
        db,
        contextDir: join(tmpDir, "context"),
        kbDir: join(tmpDir, "kb"),
        createTools: (c, dir, path, runtimeOpts) => createTools(c, dir, path, runtimeOpts),
        createProvider: () => ({ provider: fakeProvider(), model: "fake" }),
      },
      () => cfg,
      cfg,
    );
    const load = async () => {
      loaded = await loadPlugins(runtime.getConfig(), async () => ({ default: probePlugin }), {
        context: createPluginContext({ runtime, events: runtime.events }),
      });
      runtime.syncToolFactories();
    };
    let pending: Promise<void> | undefined;
    runtime.onReload(() => {
      pending = (async () => {
        for (const p of loaded) await p.stop?.();
        await load();
      })();
    });
    await load();
    const { app } = createServer({ runtime });
    return {
      app,
      async reload(next: AgentConfig) {
        cfg = next;
        runtime.reload();
        await pending;
      },
      probeTools: async () =>
        (JSON.parse((await call(app, "GET", "/api/tools")).text) as { name: string; description: string }[]).filter(
          (t) => t.name === "probe",
        ),
    };
  }

  it("serves a plugin's routes and tools from the reload that turns it on", async () => {
    const tai = await boot(withPlugin({ enabled: false }));
    expect((await call(tai.app, "GET", "/api/ext/probe-plugin/hello")).status).toBe(404);
    expect(await tai.probeTools()).toEqual([]);

    await tai.reload(withPlugin({ config: { greeting: "on" } }));

    const r = await call(tai.app, "GET", "/api/ext/probe-plugin/hello");
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toEqual({ greeting: "on" });
    expect((await tai.probeTools()).map((t) => t.description)).toEqual(["says on"]);
  });

  it("serves the changed handler and tool after a config change", async () => {
    const tai = await boot(withPlugin({ config: { greeting: "hi" } }));
    expect(JSON.parse((await call(tai.app, "GET", "/api/ext/probe-plugin/hello")).text)).toEqual({ greeting: "hi" });

    await tai.reload(withPlugin({ config: { greeting: "hello" } }));

    expect(JSON.parse((await call(tai.app, "GET", "/api/ext/probe-plugin/hello")).text)).toEqual({
      greeting: "hello",
    });
    expect((await tai.probeTools()).map((t) => t.description)).toEqual(["says hello"]);
  });

  it("stops serving a plugin's routes and tools when a reload turns it off", async () => {
    const tai = await boot(withPlugin({ config: {} }));
    expect((await call(tai.app, "GET", "/api/ext/probe-plugin/hello")).status).toBe(200);

    await tai.reload(withPlugin({ enabled: false }));

    expect((await call(tai.app, "GET", "/api/ext/probe-plugin/hello")).status).toBe(404);
    expect(await tai.probeTools()).toEqual([]);
  });

  it("exempts an auth:'none' route from the reload that adds it, and gates its path again once it's gone", async () => {
    const tai = await boot(withPlugin({ enabled: false }, { authToken: "secret" }));
    expect((await call(tai.app, "POST", "/api/ext/probe-plugin/hook")).status).toBe(401);

    await tai.reload(withPlugin({ config: {} }, { authToken: "secret" }));
    expect((await call(tai.app, "POST", "/api/ext/probe-plugin/hook")).status).toBe(200);
    // Its token sibling is still gated.
    expect((await call(tai.app, "GET", "/api/ext/probe-plugin/hello")).status).toBe(401);

    await tai.reload(withPlugin({ enabled: false }, { authToken: "secret" }));
    expect((await call(tai.app, "POST", "/api/ext/probe-plugin/hook")).status).toBe(401);
  });
});
