/**
 * The plugin has to register through `ctx`, not through core's exported
 * registration function.
 *
 * This is not style. A plugin resolves `@tailored-ai/core` from its own
 * `node_modules`, which is a different module instance — and therefore a
 * different `Registry` object — from the one the runtime uses. Importing
 * `registerMediaStoreFactory` and calling it puts the factory in a registry
 * nobody reads.
 *
 * The symptom is silence: the plugin loads, the loader logs that it loaded,
 * `validateConfig` is happy, and then the first image produces
 *
 *     this deployment has no media store, so generated audio has nowhere to go
 *
 * which reads like the store was never configured. That is exactly what
 * happened the first time this package was pointed at a live deployment.
 */
import { describe, expect, it } from "vitest";
import plugin, { meta, validateConfig } from "../index.js";

/** Stands in for the runtime's PluginContext, recording what it is handed. */
function fakeContext() {
  const registered: Array<{ registry: string; id: string }> = [];
  const disposed: string[] = [];
  const view = (registry: string) => ({
    register: (id: string, factory: unknown) => {
      registered.push({ registry, id });
      return () => disposed.push(`${registry}:${id}`);
    },
    _factoryFor: (id: string) => id,
  });
  return {
    registered,
    disposed,
    ctx: {
      mediaStores: view("mediaStores"),
      tools: view("tools"),
      providers: view("providers"),
      events: { on: () => () => {} },
    } as never,
  };
}

describe("plugin registration", () => {
  it("registers the store through ctx, not a module-level registry", () => {
    const { ctx, registered } = fakeContext();
    plugin(ctx);
    expect(registered).toEqual([{ registry: "mediaStores", id: "s3" }]);
  });

  it("returns a disposer that unregisters what it registered", () => {
    const { ctx, disposed } = fakeContext();
    const dispose = plugin(ctx);
    expect(typeof dispose).toBe("function");
    (dispose as () => void)();
    expect(disposed).toEqual(["mediaStores:s3"]);
  });

  it("declares what it registers, so `tai plugin list` can say", () => {
    expect(meta.registers).toEqual([{ kind: "media-store", id: "s3", configKey: "media" }]);
  });

  it("registers without touching config, so a misconfigured deployment still boots", () => {
    // The factory runs later, when a store is actually resolved. Throwing at
    // registration would take the whole runtime down over a missing bucket.
    const { ctx } = fakeContext();
    expect(() => plugin(ctx)).not.toThrow();
  });
});

describe("validateConfig reads where the runtime actually delivers settings", () => {
  const good = {
    bucket: "b",
    region: "us-west-2",
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "s3cret",
  };

  it("is quiet when a correct config puts settings under options", () => {
    // The regression that mattered: this deployment was told "every media
    // write will fail" on every boot while writes worked perfectly.
    const w = validateConfig({ media: { store: "s3", options: good } } as never);
    expect(w).toEqual([]);
  });

  it("still accepts the legacy top-level shape this plugin's README taught", () => {
    const w = validateConfig({ media: { store: "s3", ...good } } as never);
    expect(w).toEqual([]);
  });

  it("still complains when the settings are genuinely absent", () => {
    const w = validateConfig({ media: { store: "s3", options: {} } } as never);
    expect(w.join(" ")).toContain("bucket");
  });

  it("options wins over a stale top-level value", () => {
    const w = validateConfig({
      media: { store: "s3", bucket: "", options: good },
    } as never);
    expect(w).toEqual([]);
  });

  it("says nothing at all for another store", () => {
    expect(validateConfig({ media: { store: "disk" } } as never)).toEqual([]);
  });
});
