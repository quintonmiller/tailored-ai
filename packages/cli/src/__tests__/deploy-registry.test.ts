import { describe, expect, it } from "vitest";
import { createDeployRegistry, discoverDeployTargets } from "../deploy/registry.js";
import type { PluginManager } from "../plugins/manager.js";

/**
 * Stand-in for PluginManager. Discovery only uses `list()` and
 * `buildImporter()`, so faking those keeps these tests off the filesystem and
 * off npm — the real manager shells out to `npm install`.
 */
function fakeManager(modules: Record<string, unknown>): PluginManager {
  return {
    list: () => Object.keys(modules).map((name) => ({ name, version: "1.0.0" })),
    buildImporter: () => async (name: string) => {
      const mod = modules[name];
      if (mod instanceof Error) throw mod;
      return mod;
    },
  } as unknown as PluginManager;
}

const validTarget = {
  id: "fly",
  description: "Deploy to Fly.io",
  plan: async () => ({ steps: [] }),
  up: async () => ({ ok: true, summary: "up" }),
};

describe("createDeployRegistry", () => {
  it("ships docker as a built-in so the seam has a working implementation", () => {
    const registry = createDeployRegistry();
    expect(registry.has("docker")).toBe(true);
    expect(registry.get("docker")?.description).toMatch(/container/i);
  });
});

describe("discoverDeployTargets", () => {
  it("returns built-ins when no plugins are installed", async () => {
    const { registry, problems } = await discoverDeployTargets("/nowhere", { manager: fakeManager({}) });
    expect(registry.list()).toEqual(["docker"]);
    expect(problems).toEqual([]);
  });

  it("registers a target from a plugin's deployTargets export", async () => {
    const { registry, problems } = await discoverDeployTargets("/nowhere", {
      manager: fakeManager({ "@acme/deploy-fly": { deployTargets: [validTarget] } }),
    });
    expect(registry.has("fly")).toBe(true);
    expect(problems).toEqual([]);
  });

  it("ignores plugins that contribute no targets", async () => {
    // The common case — a provider or channel plugin. Absence is not a problem
    // and must not be reported as one.
    const { registry, problems } = await discoverDeployTargets("/nowhere", {
      manager: fakeManager({ "@tailored-ai/provider-anthropic": { default: () => {} } }),
    });
    expect(registry.list()).toEqual(["docker"]);
    expect(problems).toEqual([]);
  });

  it("reports an import failure instead of dropping the plugin silently", async () => {
    const { registry, problems } = await discoverDeployTargets("/nowhere", {
      manager: fakeManager({ "@acme/broken": new Error("boom") }),
    });
    expect(registry.list()).toEqual(["docker"]);
    expect(problems).toEqual([{ module: "@acme/broken", reason: "import failed: boom" }]);
  });

  it("keeps going after one plugin fails", async () => {
    const { registry, problems } = await discoverDeployTargets("/nowhere", {
      manager: fakeManager({
        "@acme/broken": new Error("boom"),
        "@acme/deploy-fly": { deployTargets: [validTarget] },
      }),
    });
    expect(registry.has("fly")).toBe(true);
    expect(problems).toHaveLength(1);
  });

  it("rejects a target missing up()", async () => {
    const { registry, problems } = await discoverDeployTargets("/nowhere", {
      manager: fakeManager({
        "@acme/half": { deployTargets: [{ id: "half", description: "d", plan: async () => ({ steps: [] }) }] },
      }),
    });
    expect(registry.has("half")).toBe(false);
    expect(problems[0].reason).toMatch(/missing `up\(\)`/);
  });

  it("rejects a target with no id", async () => {
    const { problems } = await discoverDeployTargets("/nowhere", {
      manager: fakeManager({ "@acme/anon": { deployTargets: [{ description: "d" }] } }),
    });
    expect(problems[0].reason).toMatch(/missing a string `id`/);
  });

  it("reports a deployTargets export that is not an array", async () => {
    const { problems } = await discoverDeployTargets("/nowhere", {
      manager: fakeManager({ "@acme/wrong": { deployTargets: validTarget } }),
    });
    expect(problems[0].reason).toMatch(/not an array/);
  });

  it("notes which plugin overrode a built-in rather than swapping it silently", async () => {
    const override = { ...validTarget, id: "docker", description: "my docker" };
    const { registry, problems } = await discoverDeployTargets("/nowhere", {
      manager: fakeManager({ "@acme/mine": { deployTargets: [override] } }),
    });
    // Override wins — a plugin replacing a built-in is legitimate — but the
    // operator gets told, since "my target stopped working" is otherwise an
    // unsearchable symptom.
    expect(registry.get("docker")?.description).toBe("my docker");
    expect(problems[0].reason).toMatch(/overrides an already-registered target/);
  });

  it("survives a plugin home that does not exist yet", async () => {
    const throwingManager = {
      list: () => {
        throw new Error("ENOENT");
      },
      buildImporter: () => async () => ({}),
    } as unknown as PluginManager;
    const { registry } = await discoverDeployTargets("/nowhere", { manager: throwingManager });
    expect(registry.list()).toEqual(["docker"]);
  });
});
