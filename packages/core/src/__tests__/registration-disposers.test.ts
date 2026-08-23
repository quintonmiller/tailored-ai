import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../config.js";
import { HttpRouteRegistry } from "../http/registry.js";
import { createPluginContext } from "../plugin-context.js";
import { loadPlugins } from "../plugins.js";
import { Registry } from "../registry.js";
import { StepExecutorRegistry } from "../resources/step-executor-registry.js";
import { toolFactoryRegistry } from "../tools/tool-factories.js";

const baseConfig = (plugins: unknown[]): AgentConfig =>
  ({
    agent: { defaultProvider: "openai" },
    providers: { openai: { apiKey: "k", baseUrl: "u", defaultModel: "m" } },
    plugins,
  }) as unknown as AgentConfig;

/** A module shaped like a plugin package, handed straight to the importer. */
const moduleOf = (register: unknown) => () => Promise.resolve({ default: register });

describe("Registry disposers", () => {
  it("returns a disposer that removes the entry it added", () => {
    const reg = new Registry<string>("test");
    const dispose = reg.register("a", "first");
    expect(reg.get("a")).toBe("first");
    dispose();
    expect(reg.has("a")).toBe(false);
  });

  it("is idempotent", () => {
    const reg = new Registry<string>("test");
    const dispose = reg.register("a", "first");
    dispose();
    reg.register("a", "second");
    // The second call already ran; calling it again must not reach into the
    // registry a second time and take out the new entry.
    dispose();
    expect(reg.get("a")).toBe("second");
  });

  it("does not remove an entry a later registration replaced", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reg = new Registry<string>("test");
    const disposeFirst = reg.register("a", "first");
    reg.register("a", "second");

    disposeFirst();

    // "second" belongs to whoever registered it. Disposing "first" must not
    // silently delete it — that is the same invisible-until-broken failure as
    // a leaked listener.
    expect(reg.get("a")).toBe("second");
    warn.mockRestore();
  });

  it("leaves unrelated entries alone", () => {
    const reg = new Registry<string>("test");
    const dispose = reg.register("a", "one");
    reg.register("b", "two");
    dispose();
    expect(reg.list()).toEqual(["b"]);
  });
});

describe("StepExecutorRegistry.registerFactory disposer", () => {
  it("removes only its own factory", () => {
    const reg = new StepExecutorRegistry();
    const first = () => ({ type: "x" }) as never;
    const second = () => ({ type: "x" }) as never;

    const disposeFirst = reg.registerFactory("x", first);
    reg.registerFactory("x", second); // replaces first
    disposeFirst();

    // The replacement survives; disposing the entry it replaced is a no-op.
    const built = reg.buildAll({} as never);
    expect(built).toHaveLength(1);
  });

  it("removes the factory it registered", () => {
    const reg = new StepExecutorRegistry();
    const dispose = reg.registerFactory("y", () => ({ type: "y" }) as never);
    expect(reg.buildAll({} as never)).toHaveLength(1);
    dispose();
    expect(reg.buildAll({} as never)).toHaveLength(0);
  });
});

describe("PluginContext registry views", () => {
  const registered: string[] = [];

  afterEach(() => {
    for (const id of registered.splice(0)) toolFactoryRegistry.unregister(id);
  });

  it("hands back a disposer that unregisters", () => {
    const ctx = createPluginContext();
    registered.push("disposer-view-test");

    const dispose = ctx.tools.register("disposer-view-test", () => []);
    expect(toolFactoryRegistry.has("disposer-view-test")).toBe(true);

    dispose();
    expect(toolFactoryRegistry.has("disposer-view-test")).toBe(false);
  });

  it("reports each registration to the collector", () => {
    const collected: Array<() => void> = [];
    const ctx = createPluginContext({ collect: (d) => collected.push(d) });
    registered.push("collect-a", "collect-b");

    ctx.tools.register("collect-a", () => []);
    ctx.tools.register("collect-b", () => []);

    expect(collected).toHaveLength(2);
    for (const dispose of collected) dispose();
    expect(toolFactoryRegistry.has("collect-a")).toBe(false);
    expect(toolFactoryRegistry.has("collect-b")).toBe(false);
  });

  it("returns a no-op disposer for step executors with no runtime", () => {
    const ctx = createPluginContext();
    // No runtime means nothing was registered, so there is nothing to undo —
    // but the contract stays total so callers never have to check.
    expect(() => ctx.stepExecutors.register("t", () => ({}) as never)()).not.toThrow();
  });
});

describe("loadPlugins teardown", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
    for (const id of ["p-tool", "p-tool-2"]) toolFactoryRegistry.unregister(id);
  });

  it("undoes registrations a plugin made through ctx, with no disposer of its own", async () => {
    const [loaded] = await loadPlugins(
      baseConfig(["fake"]),
      moduleOf((ctx: ReturnType<typeof createPluginContext>) => {
        ctx.tools.register("p-tool", () => []);
      }),
    );

    expect(toolFactoryRegistry.has("p-tool")).toBe(true);
    expect(loaded.stop).toBeTypeOf("function");

    await loaded.stop?.();
    expect(toolFactoryRegistry.has("p-tool")).toBe(false);
  });

  it("runs the plugin's own disposer before unregistering what it registered", async () => {
    const order: string[] = [];
    const [loaded] = await loadPlugins(
      baseConfig(["fake"]),
      moduleOf((ctx: ReturnType<typeof createPluginContext>) => {
        ctx.tools.register("p-tool", () => []);
        return () => {
          // The plugin may still need what it registered while shutting down,
          // so its own teardown has to come first.
          order.push(`own:${toolFactoryRegistry.has("p-tool")}`);
        };
      }),
    );

    await loaded.stop?.();
    expect(order).toEqual(["own:true"]);
    expect(toolFactoryRegistry.has("p-tool")).toBe(false);
  });

  it("unregisters in reverse order, and covers HTTP routes", async () => {
    const routes = new HttpRouteRegistry();
    const torn: string[] = [];
    const deregister = routes.deregister.bind(routes);
    vi.spyOn(routes, "deregister").mockImplementation((method: string, path: string) => {
      torn.push(path);
      return deregister(method, path);
    });

    const context = createPluginContext({
      runtime: { getHttpRoutes: () => routes } as never,
    });
    const [loaded] = await loadPlugins(
      baseConfig(["fake"]),
      moduleOf((ctx: ReturnType<typeof createPluginContext>) => {
        ctx.http.register({ method: "GET", path: "first", handler: async () => ({ status: 200 }) });
        ctx.http.register({ method: "GET", path: "second", handler: async () => ({ status: 200 }) });
      }),
      { context },
    );

    await loaded.stop?.();

    // Last in, first out: a later registration never outlives one it was
    // layered on. Routes are the case that matters most here — the registry
    // deliberately survives reload() because the router cannot unmount, so a
    // route left behind stays reachable until the process restarts.
    expect(torn.map((p) => p.split("/").pop())).toEqual(["second", "first"]);
  });

  it("keeps unregistering after a throwing disposer", async () => {
    const [loaded] = await loadPlugins(
      baseConfig(["fake"]),
      moduleOf((ctx: ReturnType<typeof createPluginContext>) => {
        ctx.tools.register("p-tool", () => []);
        return () => {
          throw new Error("teardown blew up");
        };
      }),
    );

    await expect(loaded.stop?.()).resolves.toBeUndefined();
    // A plugin that fails halfway through its own teardown must not leave its
    // registrations behind — that is worse than no teardown, because nothing
    // will retry it.
    expect(toolFactoryRegistry.has("p-tool")).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("leaves stop undefined when a plugin registers nothing and returns nothing", async () => {
    const [loaded] = await loadPlugins(
      baseConfig(["fake"]),
      moduleOf(() => {
        /* registers nothing */
      }),
    );
    expect(loaded.stop).toBeUndefined();
  });

  it("leaves stop undefined for a side-effect import", async () => {
    const [loaded] = await loadPlugins(baseConfig(["fake"]), () => Promise.resolve({}));
    expect(loaded.shape).toBe("side-effect");
    // Side-effect plugins register at module scope with no context, so nothing
    // observed what they added and there is nothing to hand back.
    expect(loaded.stop).toBeUndefined();
  });

  it("scopes collection per plugin", async () => {
    const loaded = await loadPlugins(baseConfig(["a", "b"]), (name: string) =>
      Promise.resolve({
        default: (ctx: ReturnType<typeof createPluginContext>) => {
          ctx.tools.register(name === "a" ? "p-tool" : "p-tool-2", () => []);
        },
      }),
    );

    await loaded[0].stop?.();
    // Unloading one plugin must not take another's registrations with it.
    expect(toolFactoryRegistry.has("p-tool")).toBe(false);
    expect(toolFactoryRegistry.has("p-tool-2")).toBe(true);
  });
});
