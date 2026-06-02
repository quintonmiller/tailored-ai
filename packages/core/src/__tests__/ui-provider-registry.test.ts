import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../config.js";
import type { AgentRuntime } from "../runtime.js";
import { registerUiProviderFactory, resolveUiProvider, uiProviderFactoryRegistry } from "../ui/registry.js";

function fakeRuntime(config: Partial<AgentConfig["server"]> & Record<string, unknown> = {}): AgentRuntime {
  const cfg = {
    server: config,
  } as unknown as AgentConfig;
  return { getConfig: () => cfg } as unknown as AgentRuntime;
}

describe("ui provider registry", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    uiProviderFactoryRegistry.unregister("test-builtin");
    uiProviderFactoryRegistry.unregister("test-plugin");
  });

  it("returns undefined when server.ui.enabled is false", async () => {
    registerUiProviderFactory("test-builtin", () => ({ id: "test-builtin", staticDir: "/tmp" }));
    const rt = fakeRuntime({ ui: { enabled: false, provider: "test-builtin" } });
    expect(await resolveUiProvider(rt)).toBeUndefined();
  });

  it("defaults to id 'builtin' when server.ui.provider is unset", async () => {
    const seen: string[] = [];
    registerUiProviderFactory("test-builtin", () => {
      seen.push("called");
      return { id: "test-builtin", staticDir: "/tmp" };
    });
    // Stub registry lookup: rename "builtin" to "test-builtin" for this test
    // by setting an explicit provider on config (avoids interfering with the
    // real "builtin" registration from the CLI).
    const rt = fakeRuntime({ ui: { provider: "test-builtin" } });
    const ui = await resolveUiProvider(rt);
    expect(ui?.id).toBe("test-builtin");
    expect(seen).toEqual(["called"]);
  });

  it("warns and returns undefined when factory id is unknown", async () => {
    const rt = fakeRuntime({ ui: { provider: "does-not-exist" } });
    const ui = await resolveUiProvider(rt);
    expect(ui).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/No factory registered.*does-not-exist/));
  });

  it("passes the per-provider config slice to the factory", async () => {
    const seen: Record<string, unknown>[] = [];
    registerUiProviderFactory("test-plugin", (_runtime, slice) => {
      seen.push(slice);
      return { id: "test-plugin", staticDir: "/tmp" };
    });
    const rt = fakeRuntime({
      ui: {
        provider: "test-plugin",
        "test-plugin": { theme: "dark", port: 4000 },
      },
    });
    await resolveUiProvider(rt);
    expect(seen).toEqual([{ theme: "dark", port: 4000 }]);
  });

  it("returns undefined when the factory itself returns undefined", async () => {
    registerUiProviderFactory("test-plugin", () => undefined);
    const rt = fakeRuntime({ ui: { provider: "test-plugin" } });
    expect(await resolveUiProvider(rt)).toBeUndefined();
  });

  it("can register and resolve a provider with a mount() hook", async () => {
    const mounted: unknown[] = [];
    registerUiProviderFactory("test-plugin", () => ({
      id: "test-plugin",
      mount: (app) => {
        mounted.push(app);
      },
    }));
    const rt = fakeRuntime({ ui: { provider: "test-plugin" } });
    const ui = await resolveUiProvider(rt);
    expect(ui?.mount).toBeTypeOf("function");
    ui?.mount?.({ fake: "app" });
    expect(mounted).toEqual([{ fake: "app" }]);
  });
});
