/**
 * The directory plugin's routes, mounted by the real server: what the agent
 * pages read. The plugin is imported and loaded the way the CLI loads a
 * `builtin:` module, against a real runtime, so these go through the same
 * registration and the same auth gate as any plugin route.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentConfig,
  AgentRuntime,
  type AIProvider,
  createPluginContext,
  initDatabase,
  type LoadedPlugin,
  loadPlugins,
  type StateCaller,
} from "@tailored-ai/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../index.js";

function fakeProvider(): AIProvider {
  return {
    id: "fake",
    name: "fake",
    supportsTools: true,
    chat: async () => ({ content: "ok", usage: { input: 0, output: 0 }, finishReason: "stop" }),
  };
}

function buildConfig(authToken?: string): AgentConfig {
  return {
    server: { port: 0, host: "127.0.0.1", ...(authToken ? { authToken } : {}) },
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
    agents: {
      planner: { description: "Plans the week." },
      "trip-planner": { description: "Plans trips." },
    },
    cron: { enabled: false, jobs: [] },
    context: { directory: "./data/context", kbDirectory: "./data/kb" },
    channels: {},
    tools: {},
    taskWatcher: { enabled: false, prompt: "", debounceMs: 5000, triggers: [] },
    webhooks: { enabled: false, routes: [] },
    custom_tools: {},
    commands: {},
    state: { backend: "sqlite" },
    plugins: [{ module: "builtin:directory", enabled: true }],
  } as unknown as AgentConfig;
}

const person: StateCaller = { actor: { kind: "user", name: "owner" } };

let db: ReturnType<typeof initDatabase>;
let runtime: AgentRuntime;
let plugins: LoadedPlugin[];
let tmpDir: string;
let originalHome: string | undefined;

async function start(authToken?: string) {
  const cfg = buildConfig(authToken);
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
  // The CLI's importer maps `builtin:<name>` to this subpath of core.
  plugins = await loadPlugins(cfg, (name) => import(`@tailored-ai/core/plugins/${name.slice("builtin:".length)}`), {
    context: createPluginContext({ runtime, events: runtime.events }),
  });
  expect(plugins.map((p) => [p.module, p.ok, p.shape])).toEqual([["builtin:directory", true, "register"]]);
  const service = runtime.getStateService();
  await service.put(person, {
    type: "profile",
    id: "trip-planner",
    scope: "global",
    data: { owner: "trip-planner", purpose: "Plans trips end to end." },
  });
  await service.put(person, {
    type: "commitment",
    id: "trip-planner-lisbon",
    scope: "global",
    data: { owner: "trip-planner", goal: "Lisbon trip prep", status: "open" },
  });
  await service.put(person, {
    type: "commitment",
    id: "trip-planner-gift",
    scope: "agent:trip-planner",
    data: { owner: "trip-planner", goal: "Gift", status: "waiting" },
  });
  return createServer({ runtime }).app;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  originalHome = process.env.HOME;
  tmpDir = mkdtempSync(join(tmpdir(), "directory-routes-"));
  process.env.HOME = tmpDir;
  db = initDatabase(":memory:");
  plugins = [];
});

afterEach(async () => {
  for (const p of plugins) await p.stop?.();
  await runtime.getStateService().close();
  db.close();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("the directory routes", () => {
  it("lists every agent with its profile or description and its counts", async () => {
    const app = await start();
    const res = await app.fetch(new Request("http://t/api/ext/builtin:directory/agents"));
    expect(res.status).toBe(200);
    const { agents } = (await res.json()) as { agents: Record<string, unknown>[] };
    expect(agents).toEqual([
      {
        name: "planner",
        profile: null,
        description: "Plans the week.",
        commitments: { open: 0, waiting: 0, done: 0 },
        docs: 0,
      },
      {
        name: "trip-planner",
        profile: { owner: "trip-planner", purpose: "Plans trips end to end." },
        description: "Plans trips.",
        commitments: { open: 1, waiting: 1, done: 0 },
        docs: 0,
      },
    ]);
  });

  it("gives one agent's records, private ones included, and 404s an unknown agent", async () => {
    const app = await start();
    const res = await app.fetch(new Request("http://t/api/ext/builtin:directory/agents/trip-planner"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; profile: { id: string }; commitments: { id: string }[] };
    expect(body.name).toBe("trip-planner");
    expect(body.profile.id).toBe("trip-planner");
    expect(body.commitments.map((c) => c.id).sort()).toEqual(["trip-planner-gift", "trip-planner-lisbon"]);
    const missing = await app.fetch(new Request("http://t/api/ext/builtin:directory/agents/ghost"));
    expect(missing.status).toBe(404);
  });

  it("gives an agent's page layout with its records", async () => {
    const app = await start();
    const before = await app.fetch(new Request("http://t/api/ext/builtin:directory/agents/trip-planner"));
    expect(((await before.json()) as { page: unknown }).page).toBeNull();
    await runtime.getStateService().put(person, {
      type: "page",
      id: "trip-planner",
      scope: "global",
      data: { owner: "trip-planner", note: "I plan trips.", hide: ["docs"] },
    });
    const res = await app.fetch(new Request("http://t/api/ext/builtin:directory/agents/trip-planner"));
    const body = (await res.json()) as { page: { data: Record<string, unknown> } };
    expect(body.page.data).toEqual({ owner: "trip-planner", note: "I plan trips.", hide: ["docs"] });
  });

  it("hands an agent a commitment from its page, written as the person", async () => {
    const app = await start();
    const res = await app.fetch(
      new Request("http://t/api/ext/builtin:directory/agents/planner/commitments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: "Book the dentist", doneWhen: "On the calendar" }),
      }),
    );
    expect(res.status).toBe(201);
    const { commitment, inPrompt } = (await res.json()) as { commitment: { id: string }; inPrompt: boolean };
    expect(commitment.id).toBe("planner-book-the-dentist");
    expect(inPrompt).toBe(true);
    const made = await runtime.getStateService().get(person, { type: "commitment", id: "planner-book-the-dentist" });
    expect(made?.data).toMatchObject({ owner: "planner", status: "open", from: "a person" });
    expect(made?.updatedBy).toEqual({ kind: "user", name: "owner" });

    const empty = await app.fetch(
      new Request("http://t/api/ext/builtin:directory/agents/planner/commitments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ doneWhen: "x" }),
      }),
    );
    expect(empty.status).toBe(400);
  });

  it("sits behind the server's bearer token like every other API route", async () => {
    const app = await start("secret");
    expect((await app.fetch(new Request("http://t/api/ext/builtin:directory/agents"))).status).toBe(401);
    const ok = await app.fetch(
      new Request("http://t/api/ext/builtin:directory/agents", { headers: { Authorization: "Bearer secret" } }),
    );
    expect(ok.status).toBe(200);
    const handOver = () =>
      new Request("http://t/api/ext/builtin:directory/agents/planner/commitments", {
        method: "POST",
        body: JSON.stringify({ goal: "Sneak in" }),
      });
    expect((await app.fetch(handOver())).status).toBe(401);
  });
});
