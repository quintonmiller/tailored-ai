import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../config.js";
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
    expect(out).toEqual([{ module: "node:path", ok: true }]);
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
    expect(out).toEqual([{ module: "node:path", ok: true }]);
  });

  it("skips entries with no module string", async () => {
    const out = await loadPlugins(baseConfig({ plugins: [{ config: { foo: 1 } } as never] } as never), failingImporter);
    expect(out).toHaveLength(1);
    expect(out[0].ok).toBe(false);
  });
});
