import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../config.js";
import { Registries } from "../registries.js";
import type { AgentRuntime } from "../runtime.js";
import { resolveUiProvider } from "../ui/registry.js";

function fakeRuntime(
  registries: Registries,
  config: Partial<AgentConfig["server"]> & Record<string, unknown> = {},
): AgentRuntime {
  const cfg = {
    server: config,
  } as unknown as AgentConfig;
  return { getConfig: () => cfg, registries } as unknown as AgentRuntime;
}

describe("ui provider registry", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let registries: Registries;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    registries = new Registries();
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("returns undefined when server.ui.enabled is false", async () => {
    registries.asPluginContext().uiProviders.register("test-builtin", () => ({
      id: "test-builtin",
      staticDir: "/tmp",
    }));
    const rt = fakeRuntime(registries, { ui: { enabled: false, provider: "test-builtin" } });
    expect(await resolveUiProvider(rt)).toBeUndefined();
  });

  it("resolves the configured provider id", async () => {
    const seen: string[] = [];
    registries.asPluginContext().uiProviders.register("test-builtin", () => {
      seen.push("called");
      return { id: "test-builtin", staticDir: "/tmp" };
    });
    const rt = fakeRuntime(registries, { ui: { provider: "test-builtin" } });
    const ui = await resolveUiProvider(rt);
    expect(ui?.id).toBe("test-builtin");
    expect(seen).toEqual(["called"]);
  });

  it("warns and returns undefined when factory id is unknown", async () => {
    const rt = fakeRuntime(registries, { ui: { provider: "does-not-exist" } });
    const ui = await resolveUiProvider(rt);
    expect(ui).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/No factory registered.*does-not-exist/));
  });

  it("passes the per-provider config slice to the factory", async () => {
    const seen: Record<string, unknown>[] = [];
    registries.asPluginContext().uiProviders.register("test-plugin", (_runtime, slice) => {
      seen.push(slice);
      return { id: "test-plugin", staticDir: "/tmp" };
    });
    const rt = fakeRuntime(registries, {
      ui: {
        provider: "test-plugin",
        "test-plugin": { theme: "dark", port: 4000 },
      },
    });
    await resolveUiProvider(rt);
    expect(seen).toEqual([{ theme: "dark", port: 4000 }]);
  });

  it("returns undefined when the factory itself returns undefined", async () => {
    registries.asPluginContext().uiProviders.register("test-plugin", () => undefined);
    const rt = fakeRuntime(registries, { ui: { provider: "test-plugin" } });
    expect(await resolveUiProvider(rt)).toBeUndefined();
  });

  it("can register and resolve a provider with a mount() hook", async () => {
    const mounted: unknown[] = [];
    registries.asPluginContext().uiProviders.register("test-plugin", () => ({
      id: "test-plugin",
      mount: (app) => {
        mounted.push(app);
      },
    }));
    const rt = fakeRuntime(registries, { ui: { provider: "test-plugin" } });
    const ui = await resolveUiProvider(rt);
    expect(ui?.mount).toBeTypeOf("function");
    ui?.mount?.({ fake: "app" });
    expect(mounted).toEqual([{ fake: "app" }]);
  });
});
