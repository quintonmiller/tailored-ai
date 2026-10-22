/**
 * Watches a person keeps through the real server's state routes, as the State
 * page does: one made there is checked, "check now" is setting `checkAt`, a
 * pause holds, and a change wakes the owning agent through the real runtime.
 *
 * The plugin is imported the way the CLI imports a `builtin:` module. Pages
 * come from a stubbed global `fetch`, so the plugin's guarded fetch and the
 * egress policy are the ones in the path.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentConfig,
  AgentRuntime,
  type AIProvider,
  type ChatParams,
  createPluginContext,
  initDatabase,
  type LoadedPlugin,
  loadPlugins,
  type RuntimeEventPayload,
  type StateCaller,
  toolFactoryRegistry,
} from "@tailored-ai/core";
import { resetHostSpacing } from "@tailored-ai/core/plugins/watchers-fetch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../index.js";

const MINUTE = 60_000;
const TICK_MS = 30_000;
const PAGE = "https://hotels.example/lisbon";

let price: string;
let fetched: string[];
let chats: ChatParams[];
let db: ReturnType<typeof initDatabase>;
let runtime: AgentRuntime;
let plugins: LoadedPlugin[];
let tmpDir: string;
let originalHome: string | undefined;

const person: StateCaller = { actor: { kind: "user", name: "owner" } };

const stubFetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  fetched.push(url);
  if (url !== PAGE) return new Response("not here", { status: 404 });
  const html = `<html><body><h1>Casa Alfama</h1><p>Double room ${price} per night</p></body></html>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
}) as typeof fetch;

function fakeProvider(): AIProvider {
  return {
    id: "fake",
    name: "fake",
    supportsTools: true,
    chat: async (params: ChatParams) => {
      chats.push(params);
      return { content: "Noted.", usage: { input: 0, output: 0 }, finishReason: "stop" };
    },
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
    agents: { planner: { description: "Plans trips.", tools: ["watch"] } },
    rooms: { maxWakesPerHour: 12 },
    cron: { enabled: false, jobs: [] },
    context: { directory: "./data/context", kbDirectory: "./data/kb" },
    channels: {},
    tools: {},
    taskWatcher: { enabled: false, prompt: "", debounceMs: 5000, triggers: [] },
    webhooks: { enabled: false, routes: [] },
    custom_tools: {},
    commands: {},
    state: { backend: "sqlite" },
    security: { egress: { allowHosts: ["hotels.example"] } },
    plugins: [{ module: "builtin:watchers", enabled: true }],
  } as unknown as AgentConfig;
}

async function start() {
  const cfg = buildConfig();
  runtime = new AgentRuntime(
    {
      configPath: join(tmpDir, "config.yaml"),
      db,
      contextDir: join(tmpDir, "context"),
      kbDir: join(tmpDir, "kb"),
      createTools: (config, _contextDir, _configPath, tctx) => toolFactoryRegistry.get("watch")?.(config, tctx) ?? [],
      createProvider: () => ({ provider: fakeProvider(), model: "fake" }),
    },
    () => cfg,
    cfg,
  );
  plugins = await loadPlugins(cfg, (name) => import(`@tailored-ai/core/plugins/${name.slice("builtin:".length)}`), {
    context: createPluginContext({ runtime, events: runtime.events }),
  });
  expect(plugins.map((p) => [p.module, p.ok])).toEqual([["builtin:watchers", true]]);
  runtime.syncToolFactories();
  return createServer({ runtime }).app;
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

async function watch(id: string) {
  return runtime.getStateService().get(person, { type: "watch", id });
}

/** The runner's next look, a tick on. */
async function nextLook(ms = TICK_MS) {
  resetHostSpacing();
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(Date.parse("2026-10-22T10:00:00Z"));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubGlobal("fetch", stubFetch);
  resetHostSpacing();
  originalHome = process.env.HOME;
  tmpDir = mkdtempSync(join(tmpdir(), "watchers-routes-"));
  process.env.HOME = tmpDir;
  db = initDatabase(":memory:");
  plugins = [];
  chats = [];
  fetched = [];
  price = "€212";
});

afterEach(async () => {
  for (const p of plugins) await p.stop?.();
  await runtime.getStateService().close();
  db.close();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tmpDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("watches through the state routes", () => {
  it("checks one a person made, wakes its owner when it changes, and holds a person's pause", async () => {
    const app = await start();
    const woken: Array<RuntimeEventPayload<"agent.woken">> = [];
    runtime.events.on("agent.woken", (e) => {
      woken.push(e);
    });

    // Made on the State page: no checkAt, so it's due at once, and its first check is a baseline.
    const made = await app.fetch(
      new Request(
        "http://t/api/state/watch",
        json("POST", {
          id: "lisbon",
          scope: "agent:planner",
          data: {
            owner: "planner",
            kind: "price",
            config: { url: PAGE, near: "per night" },
            label: "Lisbon hotel",
            every: "2h",
            status: "active",
          },
        }),
      ),
    );
    expect(made.status).toBe(201);
    await nextLook();
    await vi.waitFor(async () => expect((await watch("lisbon"))?.data.lastValue).toBe("€212"));
    expect(chats).toEqual([]);
    expect((await watch("lisbon"))?.data.checkAt).toBe("2026-10-22T12:00:30.000Z");

    // "Check now": a person sets checkAt to now, and the next look checks it and finds the change.
    price = "€180";
    const now = new Date().toISOString();
    const patched = await app.fetch(
      new Request("http://t/api/state/watch/lisbon", json("PATCH", { changes: { checkAt: now } })),
    );
    expect(patched.status).toBe(200);
    await nextLook();
    await vi.waitFor(() => expect(chats).toHaveLength(1));
    expect(woken).toEqual([
      { agent: "planner", wake: { kind: "watch", ref: "lisbon" }, targetKind: "session", target: "watch:lisbon" },
    ]);
    const prompt = chats[0].messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(prompt).toContain("The price fell from €212 to €180 (down 15%).");
    expect((await watch("lisbon"))?.data.lastChange).toMatchObject({
      text: "The price fell from €212 to €180 (down 15%).",
    });

    // Paused on the State page: due or not, it isn't fetched.
    const paused = await app.fetch(
      new Request("http://t/api/state/watch/lisbon", json("PATCH", { changes: { status: "paused" } })),
    );
    expect(paused.status).toBe(200);
    const before = fetched.length;
    await nextLook(3 * 60 * MINUTE);
    expect(fetched).toHaveLength(before);
  });

  it("refuses a malformed checkAt from the State page, which would otherwise never come due", async () => {
    const app = await start();
    const res = await app.fetch(
      new Request(
        "http://t/api/state/watch",
        json("POST", {
          scope: "agent:planner",
          data: { owner: "planner", kind: "page", config: { url: PAGE }, status: "active", checkAt: "tomorrow" },
        }),
      ),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("`checkAt` must match the pattern");
  });
});
