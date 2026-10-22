/**
 * A reload replaces what runtime plugins registered.
 *
 * `reload()` rebuilds the tool set from the factory registry while the last
 * load's runtime plugins are still registered. The host then disposes those
 * plugins and loads them again against the new config. Until the runtime
 * rebuilt its tools after that load, it only ever added: a plugin's tools kept
 * the instance the old registration built (so a config change took a second
 * reload), and a plugin turned off left its tools in every agent's list,
 * calling into a plugin that had been torn down.
 *
 * These go through `runtime.reload()` with the host's sequence after it, as
 * the CLI runs it: dispose the runtime plugins, load them again, sync. A test
 * that only calls `loadPlugins` can't see the bug: it is in the order.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../config.js";
import { initDatabase } from "../db/schema.js";
import { createTools } from "../factories.js";
import { createPluginContext, type PluginContext } from "../plugin-context.js";
import { type LoadedPlugin, loadPlugins } from "../plugins.js";
import { AgentRuntime, type ToolFactorySync } from "../runtime.js";
import { stateTypeRegistry } from "../state/registry.js";
import type { Tool } from "../tools/interface.js";
import { registerToolFactory } from "../tools/tool-factories.js";
import { getWatcherKind } from "../watchers/registry.js";

let tmp: string;
let disposers: Array<() => void | Promise<void>> = [];

/** Every probe tool built, with how many times it was destroyed. */
let built: Array<{ tool: Tool; destroyed: number }> = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "tai-plugin-reload-"));
  disposers = [];
  built = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  // Plugin registrations are process-wide: one test's must not reach the next one's runtime.
  for (const d of disposers) await d();
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

function probe(name: string, says: string): Tool {
  const record = { tool: undefined as unknown as Tool, destroyed: 0 };
  record.tool = {
    name,
    description: `probe ${name}`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ success: true, output: says }),
    destroy: async () => {
      record.destroyed++;
    },
  } as unknown as Tool;
  built.push(record);
  return record.tool;
}

const destroyedCount = (tool: Tool | undefined) => built.find((b) => b.tool === tool)?.destroyed;
const say = async (tool: Tool | undefined) => (await tool?.execute({}, {} as never))?.output;

/** One instance for every load, the way a plugin hands back a module-level tool. */
const shared = { tool: undefined as Tool | undefined };

/**
 * The runtime plugin under test. Its tool closes over its own config bag,
 * which is what made a config change need a second reload.
 */
function probePlugin(ctx: PluginContext) {
  const greeting = String(ctx.config.greeting ?? "hi");
  ctx.tools.register("probe", () => [probe("probe", greeting)]);
  if (ctx.config.extra === true) ctx.tools.register("probe_extra", () => [probe("probe_extra", greeting)]);
  if (ctx.config.shared === true) {
    ctx.tools.register("probe_shared", () => {
      shared.tool ??= probe("probe_shared", "same");
      return [shared.tool];
    });
  }
  if (ctx.config.stateType === true) {
    ctx.stateTypes.register({ name: "probe_record", description: "A probe record." } as never);
  }
  if (ctx.config.watcherKind === true) {
    ctx.watcherKinds.register({
      kind: "probe_watch",
      description: "Checks nothing.",
      schema: { type: "object" },
      defaultEvery: "1h",
      minEvery: "15m",
      check: () => ({ snapshot: greeting }),
    });
  }
  ctx.http.register({ method: "GET", path: "hello", handler: () => ({ json: { greeting } }) });
  // A plugin that fails partway, after its tool and route are already in.
  if (ctx.config.fail === true) throw new Error("probe failed after registering");
}

const importer = async (name: string) => {
  if (name === "probe-plugin") return { default: probePlugin };
  throw new Error(`no module ${name}`);
};

function config(plugin: Record<string, unknown> = {}): AgentConfig {
  return {
    server: { port: 3000, host: "127.0.0.1" },
    database: { path: ":memory:" },
    agent: {
      defaultProvider: "openai_compatible",
      temperature: 0.3,
      maxToolRounds: 10,
      maxHistoryTokens: 2000,
      extraInstructions: "",
    },
    providers: { openai_compatible: { baseUrl: "http://x/v1", defaultModel: "m" } },
    agents: {},
    tools: {},
    custom_tools: {},
    plugins: [{ module: "probe-plugin", ...plugin }],
  } as unknown as AgentConfig;
}

/**
 * A runtime, and a host around it that runs the runtime plugins the way the
 * CLI does: load once at start, and on every reload dispose them, load them
 * again, then sync the tool set.
 */
function start(initial: AgentConfig) {
  let cfg = initial;
  const configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, "server:\n  port: 3000\n");
  const contextDir = join(tmp, "context");
  const runtime = new AgentRuntime(
    {
      configPath,
      db: initDatabase(":memory:"),
      contextDir,
      kbDir: join(tmp, "kb"),
      createTools: (c, dir, path, runtimeOpts) => createTools(c, dir, path, runtimeOpts),
      createProvider: () => ({ provider: {} as never, model: "m" }),
    },
    () => cfg,
    cfg,
  );
  let loaded: LoadedPlugin[] = [];
  const load = async (): Promise<ToolFactorySync> => {
    loaded = await loadPlugins(runtime.getConfig(), importer, {
      context: createPluginContext({ runtime, events: runtime.events }),
    });
    return runtime.syncToolFactories();
  };
  const dispose = async () => {
    for (const p of loaded) await p.stop?.();
  };
  disposers.push(dispose);
  let pending: Promise<ToolFactorySync> | undefined;
  runtime.onReload(() => {
    pending = dispose().then(load);
  });
  return {
    runtime,
    load,
    /** Write the config, reload, and wait for the host's plugin pass. */
    async reload(next: AgentConfig): Promise<ToolFactorySync> {
      cfg = next;
      runtime.reload();
      if (!pending) throw new Error("reload did not reach the host");
      return pending;
    },
    tool: (name: string) => runtime.getTools().find((t) => t.name === name),
    count: (name: string) => runtime.getResolvableTools().filter((t) => t.name === name).length,
  };
}

describe("a reload replaces what runtime plugins registered", () => {
  it("rebuilds a plugin's tool from the new registration on the first reload after its config changes", async () => {
    const tai = start(config({ config: { greeting: "hi" } }));
    await tai.load();
    expect(await say(tai.tool("probe"))).toBe("hi");

    const sync = await tai.reload(config({ config: { greeting: "hello" } }));

    expect(sync).toEqual({ added: [], removed: [] });
    expect(await say(tai.tool("probe"))).toBe("hello");
    expect(tai.count("probe")).toBe(1);
  });

  it("removes a plugin's tools when a reload turns it off", async () => {
    const tai = start(config({ config: { extra: true } }));
    await tai.load();
    expect(tai.tool("probe")).toBeDefined();
    expect(tai.tool("probe_extra")).toBeDefined();

    const sync = await tai.reload(config({ enabled: false }));

    expect(sync.removed.sort()).toEqual(["probe", "probe_extra"]);
    expect(tai.tool("probe")).toBeUndefined();
    expect(tai.tool("probe_extra")).toBeUndefined();
  });

  it("adds a plugin's tools when a reload turns it on", async () => {
    const tai = start(config({ enabled: false }));
    await tai.load();
    expect(tai.tool("probe")).toBeUndefined();

    const sync = await tai.reload(config({ config: { greeting: "on now" } }));

    expect(sync.added).toEqual(["probe"]);
    expect(await say(tai.tool("probe"))).toBe("on now");
  });

  it("adds and drops a tool a plugin's own config switches, on the first reload", async () => {
    const tai = start(config());
    await tai.load();
    expect(tai.tool("probe_extra")).toBeUndefined();

    expect((await tai.reload(config({ config: { extra: true } }))).added).toEqual(["probe_extra"]);
    expect(tai.tool("probe_extra")).toBeDefined();

    expect((await tai.reload(config({ config: { extra: false } }))).removed).toEqual(["probe_extra"]);
    expect(tai.tool("probe_extra")).toBeUndefined();
    expect(tai.tool("probe")).toBeDefined();
  });

  it("destroys every replaced or removed instance exactly once, and never the live one", async () => {
    const tai = start(config({ config: { greeting: "one" } }));
    await tai.load();
    await tai.reload(config({ config: { greeting: "two" } }));
    await tai.reload(config({ config: { greeting: "three" } }));
    // Destroys run in the background; let them land.
    await new Promise((r) => setTimeout(r, 0));

    const live = tai.tool("probe");
    const probes = built.filter((b) => b.tool.name === "probe");
    // The first load's, then per reload the walk's (from the old registration) and the sync's.
    expect(probes).toHaveLength(5);
    for (const b of probes) expect(b.destroyed).toBe(b.tool === live ? 0 : 1);
    expect(await say(live)).toBe("three");
  });

  it("doesn't destroy an instance a plugin hands back on every load", async () => {
    shared.tool = undefined;
    const tai = start(config({ config: { shared: true } }));
    await tai.load();
    const first = tai.tool("probe_shared");

    await tai.reload(config({ config: { shared: true, greeting: "changed" } }));
    await new Promise((r) => setTimeout(r, 0));

    expect(tai.tool("probe_shared")).toBe(first);
    expect(destroyedCount(first)).toBe(0);
    expect(tai.count("probe_shared")).toBe(1);
  });

  it("brings in or drops a built-in tool that hangs on what a plugin registered", async () => {
    // Like `state`, which is offered once any world-state type exists, and the
    // types can come from a runtime plugin. Its factory is a built-in that
    // never re-registers, so only a rebuild of every factory's tools sees it.
    disposers.push(
      registerToolFactory("records_probe", () =>
        stateTypeRegistry.has("probe_record") ? [probe("records_probe", "records")] : [],
      ),
    );
    const tai = start(config({ config: { stateType: true } }));
    expect(tai.tool("records_probe")).toBeUndefined(); // the constructor's walk, before the plugin loaded

    expect((await tai.load()).added).toContain("records_probe");
    expect(tai.tool("records_probe")).toBeDefined();

    expect((await tai.reload(config({ enabled: false }))).removed).toContain("records_probe");
    expect(tai.tool("records_probe")).toBeUndefined();
  });

  it("leaves tools registered straight into the registry alone, and keeps one of each", async () => {
    const tai = start(config());
    await tai.load();
    // Registered into the fresh registry during the reload, the way McpManager's reconcile does.
    const direct = probe("mcp_style_direct", "direct");
    tai.runtime.onReload(() => tai.runtime.getToolRegistry().registerBuiltin(direct));
    // One that takes a name a factory builds: it keeps it.
    const squatter = probe("probe", "squatter");
    tai.runtime.onReload(() => tai.runtime.getToolRegistry().registerBuiltin(squatter));

    await tai.reload(config({ config: { greeting: "again" } }));

    expect(tai.tool("mcp_style_direct")).toBe(direct);
    expect(tai.tool("probe")).toBe(squatter);
    const names = tai.runtime.getResolvableTools().map((t) => t.name);
    expect(names.length).toBe(new Set(names).size);
  });

  it("hands an agent mid-turn the rebuilt tool on its next round", async () => {
    const tai = start(config({ config: { greeting: "before" } }));
    await tai.load();
    // Built once, at the start of the turn, as the loop's options are.
    const loop = tai.runtime.buildLoopOptions({ session: { id: "s1" } as never });
    expect(await say(loop.getTools?.().find((t) => t.name === "probe"))).toBe("before");

    await tai.reload(config({ config: { greeting: "after" } }));
    expect(await say(loop.getTools?.().find((t) => t.name === "probe"))).toBe("after");

    await tai.reload(config({ enabled: false }));
    expect(loop.getTools?.().some((t) => t.name === "probe")).toBe(false);
  });

  it("moves the plugin's HTTP routes with it", async () => {
    const tai = start(config({ config: { greeting: "hi" } }));
    await tai.load();
    const hello = () =>
      tai.runtime
        .getHttpRoutes()
        .list()
        .filter((r) => r.mountPath === "/api/ext/probe-plugin/hello");
    expect(hello()).toHaveLength(1);

    await tai.reload(config({ config: { greeting: "hello" } }));
    expect(hello()).toHaveLength(1);
    expect(await hello()[0].handler({} as never)).toEqual({ json: { greeting: "hello" } });

    await tai.reload(config({ enabled: false }));
    expect(hello()).toHaveLength(0);
  });

  it("leaves nothing of a plugin that throws partway through loading, and loads it cleanly once fixed", async () => {
    const tai = start(config({ config: { greeting: "broken", fail: true, stateType: true, watcherKind: true } }));
    const hello = () =>
      tai.runtime
        .getHttpRoutes()
        .list()
        .filter((r) => r.mountPath === "/api/ext/probe-plugin/hello");

    expect((await tai.load()).added).not.toContain("probe");
    expect(tai.tool("probe")).toBeUndefined();
    expect(hello()).toHaveLength(0);
    expect(stateTypeRegistry.has("probe_record")).toBe(false);
    expect(getWatcherKind("probe_watch")).toBeUndefined();

    // Fixed by a reload: it loads, rather than colliding with its own leftovers.
    expect((await tai.reload(config({ config: { greeting: "fixed" } }))).added).toEqual(["probe"]);
    expect(await say(tai.tool("probe"))).toBe("fixed");
    expect(hello()).toHaveLength(1);
    expect(await hello()[0].handler({} as never)).toEqual({ json: { greeting: "fixed" } });
  });

  it("takes out the world-state types of a plugin a reload turns off", async () => {
    const tai = start(config({ config: { stateType: true } }));
    await tai.load();
    expect(stateTypeRegistry.has("probe_record")).toBe(true);

    await tai.reload(config({ enabled: false }));
    expect(stateTypeRegistry.has("probe_record")).toBe(false);
  });

  it("replaces a plugin's watcher kind on reload, and takes it out when a reload turns the plugin off", async () => {
    const tai = start(config({ config: { watcherKind: true, greeting: "first" } }));
    await tai.load();
    const check = async () =>
      (await getWatcherKind("probe_watch")?.check({}, undefined, { now: new Date(), signal: AbortSignal.abort() }))
        ?.snapshot;
    expect(await check()).toBe("first");

    // The kind a runner finds after a reload is the new load's, not the old one's.
    await tai.reload(config({ config: { watcherKind: true, greeting: "second" } }));
    expect(await check()).toBe("second");

    await tai.reload(config({ enabled: false }));
    expect(getWatcherKind("probe_watch")).toBeUndefined();
  });
});
