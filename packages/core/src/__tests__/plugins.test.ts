import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../config.js";
import { HttpRouteRegistry } from "../http/registry.js";
import { createPluginContext } from "../plugin-context.js";
import { loadPlugins } from "../plugins.js";

const baseConfig = (overrides: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    agent: { defaultProvider: "openai" },
    providers: { openai: { apiKey: "k", baseUrl: "u", defaultModel: "m" } },
    ...overrides,
  }) as unknown as AgentConfig;

describe("loadPlugins", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  const realImporter = (name: string) => import(name);
  const failingImporter = (_name: string) => Promise.reject(new Error("not found"));

  it("returns an empty array when plugins is undefined", async () => {
    const out = await loadPlugins(baseConfig(), realImporter);
    expect(out).toEqual([]);
  });

  it("returns an empty array when plugins is empty", async () => {
    const out = await loadPlugins(baseConfig({ plugins: [] } as never), realImporter);
    expect(out).toEqual([]);
  });

  it("logs success when a plugin resolves", async () => {
    const out = await loadPlugins(baseConfig({ plugins: ["node:path"] } as never), realImporter);
    expect(out).toEqual([{ module: "node:path", ok: true, shape: "side-effect" }]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("loaded node:path"));
  });

  it("logs failure and continues when a plugin cannot be resolved", async () => {
    const out = await loadPlugins(baseConfig({ plugins: ["@nope/does-not-exist", "node:path"] } as never), (name) =>
      name === "node:path" ? import(name) : Promise.reject(new Error("not found")),
    );
    expect(out).toHaveLength(2);
    expect(out[0].ok).toBe(false);
    expect(out[0].module).toBe("@nope/does-not-exist");
    expect(out[1].ok).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("failed to load @nope/does-not-exist"));
  });

  it("accepts the object form { module, config }", async () => {
    const out = await loadPlugins(
      baseConfig({
        plugins: [{ module: "node:path", config: { foo: 1 } }],
      } as never),
      realImporter,
    );
    expect(out).toEqual([{ module: "node:path", ok: true, shape: "side-effect" }]);
  });

  it("skips entries with no module string", async () => {
    const out = await loadPlugins(baseConfig({ plugins: [{ config: { foo: 1 } } as never] } as never), failingImporter);
    expect(out).toHaveLength(1);
    expect(out[0].ok).toBe(false);
  });

  it("invokes default(ctx) with a per-entry context carrying the base views", async () => {
    const marker = Symbol("ctx");
    let received: { marker?: symbol; config?: unknown } | undefined;
    const ctx = { marker } as never;
    const importer = () =>
      Promise.resolve({
        default: (passedCtx: { marker?: symbol; config?: unknown }) => {
          received = passedCtx;
        },
      });
    const out = await loadPlugins(baseConfig({ plugins: ["fake-plugin"] } as never), importer, { context: ctx });
    expect(out).toEqual([{ module: "fake-plugin", ok: true, shape: "register" }]);
    // The loader hands each entry a shallow copy of the base context with a
    // per-entry `config`, so base properties are carried through by value.
    expect(received?.marker).toBe(marker);
    expect(received?.config).toEqual({});
  });

  it("awaits async register(ctx)", async () => {
    let resolved = false;
    const importer = () =>
      Promise.resolve({
        default: async () => {
          await new Promise((r) => setTimeout(r, 1));
          resolved = true;
        },
      });
    const out = await loadPlugins(baseConfig({ plugins: ["async-plugin"] } as never), importer);
    expect(out[0].ok).toBe(true);
    expect(out[0].shape).toBe("register");
    expect(resolved).toBe(true);
  });

  it("threads the per-entry config bag into ctx.config", async () => {
    let received: Record<string, unknown> | undefined;
    const importer = () =>
      Promise.resolve({
        default: (ctx: { config: Record<string, unknown> }) => {
          received = ctx.config;
        },
      });
    await loadPlugins(
      baseConfig({ plugins: [{ module: "cfg-plugin", config: { maxStallRetries: 5 } }] } as never),
      importer,
    );
    expect(received).toEqual({ maxStallRetries: 5 });
  });

  it("passes an empty config object for a bare-string entry", async () => {
    let received: unknown;
    const importer = () =>
      Promise.resolve({
        default: (ctx: { config: Record<string, unknown> }) => {
          received = ctx.config;
        },
      });
    await loadPlugins(baseConfig({ plugins: ["bare-plugin"] } as never), importer);
    expect(received).toEqual({});
  });

  it("gives each entry its own config without bleeding across entries", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const importer = () =>
      Promise.resolve({
        default: (ctx: { config: Record<string, unknown> }) => {
          seen.push(ctx.config);
        },
      });
    await loadPlugins(
      baseConfig({
        plugins: [{ module: "a", config: { which: "a" } }, { module: "b", config: { which: "b" } }, "c"],
      } as never),
      importer,
    );
    expect(seen).toEqual([{ which: "a" }, { which: "b" }, {}]);
  });

  it("skips an entry with enabled: false without importing it", async () => {
    const importer = vi.fn(() => Promise.resolve({ default: () => {} }));
    const out = await loadPlugins(
      baseConfig({ plugins: [{ module: "off-plugin", enabled: false }] } as never),
      importer,
    );
    expect(importer).not.toHaveBeenCalled();
    expect(out).toEqual([{ module: "off-plugin", ok: true, shape: "skipped" }]);
  });

  it("loads an entry with enabled: true normally", async () => {
    const importer = vi.fn(() => Promise.resolve({ default: () => {} }));
    const out = await loadPlugins(baseConfig({ plugins: [{ module: "on-plugin", enabled: true }] } as never), importer);
    expect(importer).toHaveBeenCalledTimes(1);
    expect(out[0]).toMatchObject({ module: "on-plugin", ok: true, shape: "register" });
  });

  it("captures the disposer a register plugin returns on stop", async () => {
    const dispose = vi.fn();
    const importer = () => Promise.resolve({ default: () => dispose });
    const out = await loadPlugins(baseConfig({ plugins: ["disposer-plugin"] } as never), importer);
    expect(typeof out[0].stop).toBe("function");
    await out[0].stop?.();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("awaits an async disposer", async () => {
    let disposed = false;
    const importer = () =>
      Promise.resolve({
        default: () => async () => {
          await new Promise((r) => setTimeout(r, 1));
          disposed = true;
        },
      });
    const out = await loadPlugins(baseConfig({ plugins: ["async-disposer"] } as never), importer);
    await out[0].stop?.();
    expect(disposed).toBe(true);
  });

  it("leaves stop undefined when a register plugin returns nothing", async () => {
    const importer = () => Promise.resolve({ default: () => {} });
    const out = await loadPlugins(baseConfig({ plugins: ["no-disposer"] } as never), importer);
    expect(out[0].stop).toBeUndefined();
  });

  it("captures the module's meta export (#228)", async () => {
    const meta = {
      name: "Acme provider",
      description: "Test provider.",
      registers: [{ kind: "provider", id: "acme", configKey: "providers.acme" }],
    };
    const importer = () => Promise.resolve({ default: () => {}, meta });
    const out = await loadPlugins(baseConfig({ plugins: ["acme"] } as never), importer);
    expect(out[0].meta).toEqual(meta);
  });

  it("captures meta on side-effect plugins too", async () => {
    const importer = () => Promise.resolve({ meta: { name: "Side effect" } });
    const out = await loadPlugins(baseConfig({ plugins: ["sideways"] } as never), importer);
    expect(out[0].shape).toBe("side-effect");
    expect(out[0].meta).toEqual({ name: "Side effect" });
  });

  it("ignores a malformed meta export", async () => {
    const importer = () => Promise.resolve({ default: () => {}, meta: "not-an-object" });
    const out = await loadPlugins(baseConfig({ plugins: ["bad-meta"] } as never), importer);
    expect(out[0].ok).toBe(true);
    expect(out[0].meta).toBeUndefined();
  });

  it("collects and prints validateConfig warnings (#229)", async () => {
    const importer = () =>
      Promise.resolve({
        default: () => {},
        validateConfig: (config: AgentConfig) => (config.providers.acme ? [] : ["providers.acme is not configured"]),
      });
    const out = await loadPlugins(baseConfig({ plugins: ["acme"] } as never), importer);
    expect(out[0].warnings).toEqual(["providers.acme is not configured"]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("providers.acme is not configured"));
  });

  it("tolerates a throwing validateConfig without failing the load", async () => {
    const importer = () =>
      Promise.resolve({
        default: () => {},
        validateConfig: () => {
          throw new Error("validator bug");
        },
      });
    const out = await loadPlugins(baseConfig({ plugins: ["explosive"] } as never), importer);
    expect(out[0].ok).toBe(true);
    expect(out[0].warnings).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("validateConfig threw"));
  });

  it("namespaces a plugin's ctx.http routes under its module name", async () => {
    const registry = new HttpRouteRegistry();
    // Minimal runtime stub: the loader derives the per-entry http view from
    // ctx.runtime.getHttpRoutes(), so only that method needs to exist.
    const ctx = createPluginContext({
      runtime: { getHttpRoutes: () => registry } as never,
    });
    const importer = () =>
      Promise.resolve({
        default: (passed: { http: { register: (d: unknown) => void } }) => {
          passed.http.register({ method: "GET", path: "status", handler: async () => ({ status: 200 }) });
        },
      });
    await loadPlugins(baseConfig({ plugins: ["acme-widget"] } as never), importer, { context: ctx });
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0].mountPath).toBe("/api/ext/acme-widget/status");
  });
});
