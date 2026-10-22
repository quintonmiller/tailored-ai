/**
 * The watchers plugin as the CLI loads it: its type, kinds and tool, what the
 * `watch` tool lets an agent do and to whose watches, a reload in the middle
 * of a check, and a change waking the owner through the real runtime's
 * `wakeAgent`, under the hourly ceiling every unasked-for turn shares.
 *
 * Pages come from a stubbed global `fetch`, so the plugin's own guarded fetch,
 * egress policy included, is what the kinds go through.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../config.js";
import { DEFAULT_DISABLED_PLUGIN_MODULES, DEFAULT_PLUGIN_MODULES } from "../config.js";
import { initDatabase } from "../db/schema.js";
import type { RuntimeEventPayload } from "../events.js";
import { TypedEventBus } from "../events.js";
import { createPluginContext } from "../plugin-context.js";
import * as watchersPlugin from "../plugins/watchers.js";
import { resetHostSpacing } from "../plugins/watchers-fetch.js";
import { MAX_WATCHES, WATCH_TYPE } from "../plugins/watchers-records.js";
import { resetWatchSchedule, TICK_MS } from "../plugins/watchers-runner.js";
import { settingsFrom, TOOL_PARAMS, TURNED_OFF } from "../plugins/watchers-tool.js";
import { type LoadedPlugin, loadPlugins } from "../plugins.js";
import type { AIProvider, ChatResponse } from "../providers/interface.js";
import { AgentRuntime } from "../runtime.js";
import { stateTypeRegistry } from "../state/registry.js";
import { type StateCaller, StateService } from "../state/service.js";
import type { StateRecord } from "../state/types.js";
import type { Tool } from "../tools/interface.js";
import { StateTool } from "../tools/state.js";
import { toolFactoryRegistry } from "../tools/tool-factories.js";
import { getWatcherKind, type WatcherKind } from "../watchers/registry.js";

const PERSON: StateCaller = { actor: { kind: "user", name: "owner" }, source: { surface: "web" } };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** What each address serves now; a function to make an answer wait. */
let pages: Record<string, string | (() => Promise<string>)>;
let fetched: string[];

function hotelPage(price: string, extra = ""): string {
  return `<html><head><title>Casa Alfama</title></head><body><h1>Casa Alfama</h1><p>Double room ${price} per night</p>${extra}</body></html>`;
}

const stubFetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  fetched.push(url);
  const page = pages[url];
  if (page === undefined) return new Response("not here", { status: 404, headers: { "content-type": "text/plain" } });
  const body = typeof page === "function" ? await page() : page;
  return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
}) as typeof fetch;

/** A call's outcome, as the model reads it. */
async function callTool(tool: Tool, agent: string, args: Record<string, unknown>) {
  resetHostSpacing();
  const result = await tool.execute(args, { sessionId: "s", workingDirectory: "/", env: {}, agentName: agent });
  return { ok: result.success, text: result.success ? String(result.output) : String(result.error) };
}

beforeEach(() => {
  pages = {};
  fetched = [];
  resetHostSpacing();
  resetWatchSchedule();
  vi.stubGlobal("fetch", stubFetch);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the watchers plugin, with a recording waker", () => {
  let db: Database.Database;
  let service: StateService;
  let events: TypedEventBus;
  let loaded: LoadedPlugin[];
  let wakes: Array<{ agent: string; sessionKey?: string; prompt: string }>;

  function fakeRuntime() {
    return {
      getConfig: () => ({ agents: { planner: {}, writer: {} }, security: { egress: { allowHosts: ["example"] } } }),
      getStateService: () => service,
      wakeAgent: async (agent: string, opts: { sessionKey?: string; prompt: string }) => {
        wakes.push({ agent, sessionKey: opts.sessionKey, prompt: opts.prompt });
        return "ran";
      },
    } as unknown as AgentRuntime;
  }

  async function load(): Promise<LoadedPlugin> {
    const [plugin] = await loadPlugins(
      { plugins: [{ module: "builtin:watchers", enabled: true }] } as never,
      async () => watchersPlugin,
      { context: createPluginContext({ runtime: fakeRuntime(), events }) },
    );
    expect(plugin.ok).toBe(true);
    loaded.push(plugin);
    return plugin;
  }

  function build(): Tool {
    const factory = toolFactoryRegistry.get("watch");
    if (!factory) throw new Error("no watch tool registered");
    return factory({} as never, { getStateService: () => service })[0];
  }

  const call = (agent: string, args: Record<string, unknown>) => callTool(build(), agent, args);

  async function run(agent: string, args: Record<string, unknown>): Promise<string> {
    const r = await call(agent, args);
    if (!r.ok) throw new Error(`watch ${JSON.stringify(args)} failed: ${r.text}`);
    return r.text;
  }

  async function watches(): Promise<StateRecord[]> {
    return service.query(PERSON, { type: WATCH_TYPE, includeArchived: true });
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(Date.parse("2026-10-22T10:00:00Z"));
    db = new Database(":memory:");
    events = new TypedEventBus();
    service = new StateService({ getConfig: () => ({ state: { backend: "sqlite" } }), db, events });
    loaded = [];
    wakes = [];
    pages["https://hotels.example/lisbon"] = hotelPage("€212");
    await load();
  });

  afterEach(async () => {
    for (const plugin of loaded.splice(0)) await plugin.stop?.();
    await service.close();
    db.close();
  });

  it("ships installed but off", () => {
    expect(DEFAULT_DISABLED_PLUGIN_MODULES).toContain("builtin:watchers");
    expect(DEFAULT_PLUGIN_MODULES as readonly string[]).not.toContain("builtin:watchers");
  });

  it("registers its type, its two kinds and its tool, and takes every one back when unloaded", async () => {
    expect(stateTypeRegistry.has(WATCH_TYPE)).toBe(true);
    expect(getWatcherKind("page")).toBeDefined();
    expect(getWatcherKind("price")).toBeDefined();
    expect(toolFactoryRegistry.has("watch")).toBe(true);
    const tool = build();
    expect(tool.description.split(/(?<=\.)\s/)).toHaveLength(2);

    await loaded[0].stop?.();
    loaded = [];
    expect(stateTypeRegistry.has(WATCH_TYPE)).toBe(false);
    expect(getWatcherKind("page")).toBeUndefined();
    expect(getWatcherKind("price")).toBeUndefined();
    expect(toolFactoryRegistry.has("watch")).toBe(false);
    // A call already running when it went says so rather than failing against a type that's gone.
    expect((await callTool(tool, "planner", { action: "list" })).text).toBe(TURNED_OFF);
  });

  it("adds a watch in its owner's private scope, from a first look that sets the baseline", async () => {
    const text = await run("planner", {
      action: "add",
      kind: "price",
      config: { url: "https://hotels.example/lisbon", near: "per night" },
      label: "Lisbon hotel price",
      note: "Tell the travel room if it drops under €190.",
    });
    expect(text).toContain('Watching "Lisbon hotel price" as lisbon-hotel-price-');
    expect(text).toContain("price on hotels.example/lisbon, every 2h.");
    expect(text).toContain("It reads €212 now.");

    const [w] = await watches();
    expect(w.scope).toBe("agent:planner");
    expect(w.updatedBy).toEqual({ kind: "plugin", name: "watchers" });
    expect(w.source).toEqual({ tool: "watch", onBehalfOf: "planner" });
    expect(w.data).toMatchObject({
      owner: "planner",
      kind: "price",
      config: { url: "https://hotels.example/lisbon", near: "per night" },
      every: "2h",
      status: "active",
      lastValue: "€212",
      failures: 0,
      checkedAt: "2026-10-22T10:00:00.000Z",
      checkAt: "2026-10-22T12:00:00.000Z",
      note: "Tell the travel room if it drops under €190.",
    });
    expect(wakes).toEqual([]);
  });

  it("forgives a small model's slips: settings beside config, a number as text, every with its 'every'", async () => {
    const text = await run("planner", {
      action: "add",
      kind: "price",
      url: "https://hotels.example/lisbon",
      near: "per night",
      threshold: "5%",
      every: "every 3 hours",
    });
    expect(text).toContain("every 3 hours");
    const [w] = await watches();
    expect(w.data.config).toEqual({ url: "https://hotels.example/lisbon", near: "per night", threshold: 5 });
    expect(w.data.label).toBe("price on hotels.example/lisbon");
  });

  it("never lifts a setting named like one of its own parameters: that one is the tool's", () => {
    const tool = build();
    expect([...TOOL_PARAMS].sort()).toEqual(Object.keys(tool.parameters.properties as object).sort());
    const mail: WatcherKind = {
      kind: "mail",
      description: "New mail with a label.",
      schema: { type: "object", properties: { label: { type: "string" }, from: { type: "string" } } },
      defaultEvery: "1h",
      minEvery: "15m",
      check: () => ({ snapshot: {} }),
    };
    expect(settingsFrom(mail, { action: "add", kind: "mail", label: "Bank mail", from: "bank.example" })).toEqual({
      from: "bank.example",
    });
    expect(settingsFrom(mail, { action: "add", kind: "mail", label: "Bank mail", config: { label: "Bank" } })).toEqual({
      label: "Bank",
    });
  });

  it("raises an interval under the kind's floor, and says so", async () => {
    const text = await run("planner", {
      action: "add",
      kind: "page",
      config: { url: "https://hotels.example/lisbon" },
      every: "1m",
    });
    expect(text).toContain("page watches run at most every 15m, so that's how often this one runs.");
    expect((await watches())[0].data.every).toBe("15m");
  });

  it("refuses settings it can't use, saying what they are, and saves nothing", async () => {
    let r = await call("planner", {
      action: "add",
      kind: "price",
      config: { url: "hotels.example", selector: ".price" },
    });
    expect(r.ok).toBe(false);
    expect(r.text).toContain("The settings for a price watch need fixing:");
    expect(r.text).toContain("`url` must match the pattern ^https?://");
    expect(r.text).toContain("`selector` is not a field of this type");
    expect(r.text).toContain("Settings: url (string, required), near (string), threshold (number).");

    r = await call("planner", { action: "add", kind: "stocks", config: {} });
    expect(r.text).toMatch(/^There's no "stocks" kind of watch\. Kinds: page \(.+\); price \(.+\)\.$/);

    r = await call("planner", {
      action: "add",
      kind: "price",
      config: { url: "https://hotels.example/lisbon", near: "per week" },
    });
    expect(r.text).toBe(
      "Nothing was saved: the first look at it failed. “per week” isn't on the page. Fix the settings and add it again.",
    );

    // A host the egress policy keeps out is refused before anything is fetched.
    r = await call("planner", { action: "add", kind: "page", config: { url: "http://127.0.0.1:8080/admin" } });
    expect(r.text).toContain("127.0.0.1 is not reachable from here: loopback");
    expect(fetched.filter((u) => u.includes("127.0.0.1"))).toEqual([]);
    expect(await watches()).toEqual([]);
  });

  it("gives back the watch it already has rather than adding the same one twice", async () => {
    const args = { action: "add", kind: "page", config: { url: "https://hotels.example/lisbon" } };
    const first = await run("planner", args);
    const id = /as (\S+):/.exec(first)?.[1];
    expect(await run("planner", args)).toBe(
      `You already watch this as ${id} ("page on hotels.example/lisbon"). Nothing new was added.`,
    );
    expect(await watches()).toHaveLength(1);
  });

  it(`keeps each agent to ${MAX_WATCHES} watches`, async () => {
    for (let i = 0; i < MAX_WATCHES; i++) {
      await service.put(PERSON, {
        type: WATCH_TYPE,
        scope: "agent:planner",
        data: { owner: "planner", kind: "page", config: { url: `https://hotels.example/${i}` }, status: "paused" },
      });
    }
    const r = await call("planner", { action: "add", kind: "page", config: { url: "https://hotels.example/lisbon" } });
    expect(r.text).toBe(
      `You keep ${MAX_WATCHES} watches, the most one agent may. Remove one you no longer need first.`,
    );
  });

  it("lists, pauses, resumes and removes an agent's own watches, by id or by label", async () => {
    await run("planner", {
      action: "add",
      kind: "price",
      config: { url: "https://hotels.example/lisbon" },
      label: "Lisbon",
    });
    const [w] = await watches();

    let list = await run("planner", { action: "list" });
    expect(list).toContain(
      `- ${w.id} "Lisbon": price on hotels.example/lisbon, every 2h, active, reads €212, next check in 2 hours`,
    );

    expect(await run("planner", { action: "pause", id: "Lisbon" })).toBe(
      `Paused ${w.id}. It isn't checked until you resume it.`,
    );
    expect((await watches())[0].data.status).toBe("paused");
    list = await run("planner", { action: "list" });
    expect(list).toContain("every 2h, paused, reads €212");

    expect(await run("planner", { action: "resume", id: w.id })).toBe(
      `Resumed ${w.id}. It's checked again within a minute.`,
    );
    const resumed = (await watches())[0];
    expect(resumed.data).toMatchObject({ status: "active", failures: 0, checkAt: "2026-10-22T10:00:00.000Z" });

    expect(await run("planner", { action: "remove", id: w.id })).toContain(`Removed ${w.id}.`);
    const removed = (await watches())[0];
    expect(removed.archivedAt).toBeDefined();
    expect(removed.archiveReason).toBe("removed by planner");
    expect(await run("planner", { action: "list" })).toMatch(/^You have no watches\./);
  });

  it("keeps one agent's watches out of another's reach, through the tool and through state", async () => {
    await run("planner", {
      action: "add",
      kind: "page",
      config: { url: "https://hotels.example/lisbon" },
      label: "Lisbon",
    });
    const [w] = await watches();

    for (const action of ["pause", "resume", "remove"]) {
      expect((await call("writer", { action, id: w.id })).text).toBe(
        `You have no watch called "${w.id}". Action list shows yours.`,
      );
    }
    expect((await call("writer", { action: "pause", id: "Lisbon" })).ok).toBe(false);
    expect(await run("writer", { action: "list" })).toMatch(/^You have no watches\./);
    expect((await watches())[0].data.status).toBe("active");

    // Agents can't write watches through `state`, even their own: the tool is the way.
    const state = new StateTool(() => service);
    const ctx = { sessionId: "s", workingDirectory: "/", env: {}, agentName: "planner" };
    const patched = await state.execute(
      { action: "patch", type: WATCH_TYPE, id: w.id, data: { status: "paused" } },
      ctx,
    );
    expect(patched.success).toBe(false);
    expect(patched.error).toContain("You can read watch records but not change them.");
    // And another agent can't read it there either.
    const read = await state.execute({ action: "get", type: WATCH_TYPE, id: w.id }, { ...ctx, agentName: "writer" });
    expect(read.output).not.toContain("hotels.example");
  });

  it("doesn't check a watch twice when a reload comes in the middle of its check", async () => {
    await run("planner", {
      action: "add",
      kind: "price",
      config: { url: "https://hotels.example/lisbon", near: "per night" },
    });
    expect(fetched).toHaveLength(1);

    let answer!: (body: string) => void;
    pages["https://hotels.example/lisbon"] = () =>
      new Promise<string>((resolve) => {
        answer = resolve;
      });
    resetHostSpacing();
    vi.setSystemTime(Date.now() + 2 * HOUR);
    await vi.advanceTimersByTimeAsync(TICK_MS);
    await vi.waitFor(() => expect(fetched).toHaveLength(2));

    // The reload: this load goes, the next starts, and its runner looks at once.
    await loaded[0].stop?.();
    loaded = [];
    await load();
    resetHostSpacing();
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(fetched).toHaveLength(2);

    answer(hotelPage("€150"));
    await vi.waitFor(() => expect(wakes).toHaveLength(1));
    expect(wakes[0].prompt).toContain("The price fell from €212 to €150 (down 29%).");
    await vi.advanceTimersByTimeAsync(TICK_MS * 4);
    expect(fetched).toHaveLength(2);
    expect(wakes).toHaveLength(1);
  });

  it("stops checking once unloaded", async () => {
    await run("planner", { action: "add", kind: "page", config: { url: "https://hotels.example/lisbon" } });
    await loaded[0].stop?.();
    loaded = [];
    vi.setSystemTime(Date.now() + 3 * HOUR);
    await vi.advanceTimersByTimeAsync(TICK_MS * 4);
    expect(fetched).toHaveLength(1);
  });
});

describe("a change, through the real runtime's waker", () => {
  let db: ReturnType<typeof initDatabase>;
  let home: string;
  let plugins: LoadedPlugin[];
  let asked: string[];

  const provider: AIProvider = {
    id: "openai_compatible",
    name: "scripted",
    supportsTools: true,
    async chat(params): Promise<ChatResponse> {
      asked.push(params.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n"));
      return { content: "Noted.", usage: { input: 1, output: 1 }, finishReason: "stop" };
    },
  };

  async function start(maxWakesPerHour: number): Promise<AgentRuntime> {
    const config = {
      server: { port: 3000, host: "127.0.0.1" },
      database: { path: ":memory:" },
      providers: { openai_compatible: { baseUrl: "http://x", defaultModel: "x" } },
      agent: {
        defaultProvider: "openai_compatible",
        maxToolRounds: 4,
        maxHistoryTokens: 8000,
        temperature: 0.3,
        extraInstructions: "",
      },
      agents: { planner: { tools: ["watch"] } },
      rooms: { maxWakesPerHour },
      tools: {},
      custom_tools: {},
      cron: { enabled: false, jobs: [] },
      context: { directory: "./data/context", kbDirectory: "./data/kb" },
      prompts: { allowShellExpansion: false, shellTimeoutMs: 5000, maxIncludeDepth: 5 },
      permissions: { defaultMode: "auto", timeoutMs: 0, timeoutAction: "reject", tools: {} },
      workflows: { directory: join(home, "workflows") },
      tasks: { backend: "native" as const },
      state: { backend: "sqlite" },
      security: { egress: { allowHosts: ["example"] } },
      plugins: [{ module: "builtin:watchers", enabled: true }],
    } as unknown as AgentConfig;
    const runtime = new AgentRuntime(
      {
        configPath: "/dev/null",
        db,
        contextDir: join(home, "context"),
        kbDir: join(home, "kb"),
        createTools: (c, _dir, _path, tctx) => toolFactoryRegistry.get("watch")?.(c, tctx) ?? [],
        createProvider: () => ({ provider, model: "x" }),
      },
      () => config,
      config,
    );
    plugins = await loadPlugins(config, async () => watchersPlugin, {
      context: createPluginContext({ runtime, events: runtime.events }),
    });
    expect(plugins.map((p) => p.ok)).toEqual([true]);
    runtime.syncToolFactories();
    return runtime;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(Date.parse("2026-10-22T10:00:00Z"));
    db = initDatabase(":memory:");
    home = mkdtempSync(join(tmpdir(), "tai-watchers-"));
    plugins = [];
    asked = [];
  });

  afterEach(async () => {
    for (const p of plugins) await p.stop?.();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("wakes the owner in the watch's session, says so on the bus, and counts toward the owner's hour", async () => {
    const runtime = await start(1);
    const woken: Array<RuntimeEventPayload<"agent.woken">> = [];
    runtime.events.on("agent.woken", (e) => {
      woken.push(e);
    });
    const tool = toolFactoryRegistry.get("watch")?.(runtime.getConfig(), {
      getStateService: () => runtime.getStateService(),
    })[0] as Tool;
    pages["https://hotels.example/lisbon"] = hotelPage("€212");
    const added = await callTool(tool, "planner", {
      action: "add",
      kind: "price",
      config: { url: "https://hotels.example/lisbon", near: "per night" },
      label: "Lisbon hotel",
      every: "30m",
    });
    expect(added.ok).toBe(true);
    const [w] = await runtime.getStateService().query(PERSON, { type: WATCH_TYPE });

    // The first change: the planner's one wake this hour.
    pages["https://hotels.example/lisbon"] = hotelPage("€180");
    resetHostSpacing();
    await vi.advanceTimersByTimeAsync(30 * MINUTE + TICK_MS);
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    expect(woken).toEqual([
      { agent: "planner", wake: { kind: "watch", ref: w.id }, targetKind: "session", target: `watch:${w.id}` },
    ]);
    expect(asked[0]).toContain('Your watch "Lisbon hotel" saw a change.');
    expect(asked[0]).toContain("The price fell from €212 to €180 (down 15%).");

    // The second, inside the same hour: turned away at the ceiling, and owed.
    pages["https://hotels.example/lisbon"] = hotelPage("€150");
    resetHostSpacing();
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    await vi.waitFor(async () => {
      const now = await runtime.getStateService().get(PERSON, { type: WATCH_TYPE, id: w.id });
      expect(now?.data.tellAt).toBeDefined();
    });
    expect(asked).toHaveLength(1);

    // Once the hour has room, the owed wake runs, with the latest change.
    await vi.advanceTimersByTimeAsync(35 * MINUTE);
    await vi.waitFor(() => expect(asked).toHaveLength(2));
    expect(asked[1]).toContain("The price fell from €180 to €150 (down 17%).");
    const told = await runtime.getStateService().get(PERSON, { type: WATCH_TYPE, id: w.id });
    expect(told?.data.tellAt).toBeUndefined();
  });

  it("wakes nobody while agents are paused, and tells the owner once they're back", async () => {
    const runtime = await start(5);
    const tool = toolFactoryRegistry.get("watch")?.(runtime.getConfig(), {
      getStateService: () => runtime.getStateService(),
    })[0] as Tool;
    pages["https://hotels.example/lisbon"] = hotelPage("€212");
    await callTool(tool, "planner", {
      action: "add",
      kind: "price",
      config: { url: "https://hotels.example/lisbon" },
      every: "30m",
    });
    runtime.setAgentsPaused({ paused: true });
    pages["https://hotels.example/lisbon"] = hotelPage("€100");
    resetHostSpacing();
    await vi.advanceTimersByTimeAsync(30 * MINUTE + TICK_MS);
    const [w] = await runtime.getStateService().query(PERSON, { type: WATCH_TYPE });
    await vi.waitFor(async () => {
      const now = await runtime.getStateService().get(PERSON, { type: WATCH_TYPE, id: w.id });
      expect(now?.data.tellAt).toBeDefined();
    });
    expect(asked).toEqual([]);

    runtime.setAgentsPaused({ paused: false });
    await vi.advanceTimersByTimeAsync(6 * MINUTE);
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]).toContain("The price fell from €212 to €100");
  });
});
