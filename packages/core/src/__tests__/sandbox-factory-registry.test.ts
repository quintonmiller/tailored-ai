import { afterEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "../config.js";
import { createSandbox, registerSandboxFactory, sandboxFactoryRegistry } from "../sandboxes/factory.js";
import type { Sandbox } from "../sandboxes/interface.js";

// Ensure built-ins are registered (index.ts side-effect; we import directly here)

function minimalConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    server: { port: 3000, host: "0.0.0.0" },
    database: { path: ":memory:" },
    providers: { openai_compatible: { baseUrl: "http://localhost:11434/v1", defaultModel: "x" } },
    agent: {
      defaultProvider: "openai_compatible",
      extraInstructions: "",
      maxHistoryTokens: 2000,
      maxContextTokens: 32768,
      temperature: 0.3,
      maxToolRounds: 10,
    },
    agents: {},
    cron: { enabled: false, jobs: [] },
    context: { directory: "./data/context", kbDirectory: "./data/kb" },
    channels: {},
    tools: {},
    taskWatcher: { enabled: false, prompt: "", debounceMs: 5000, triggers: [] },
    webhooks: { enabled: false, routes: [] },
    custom_tools: {},
    commands: {},
    ...overrides,
  } as AgentConfig;
}

function fakeSandbox(id: string): Sandbox {
  return {
    kind: id,
    prepare: async () => ({ kind: id, cwd: "/fake" }),
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    readFile: async () => "",
    writeFile: async () => {},
    cleanup: async () => {},
  };
}

describe("sandbox factory registry — built-ins", () => {
  it("registers 'host' built-in", () => {
    expect(sandboxFactoryRegistry.has("host")).toBe(true);
  });

  it("registers 'docker' built-in", () => {
    expect(sandboxFactoryRegistry.has("docker")).toBe(true);
  });

  it("registers 'podman' built-in", () => {
    expect(sandboxFactoryRegistry.has("podman")).toBe(true);
  });

  it("createSandbox resolves 'host' without config", () => {
    const sandbox = createSandbox(minimalConfig());
    expect(sandbox.kind).toBe("host");
  });

  it("createSandbox resolves agent.sandbox override", () => {
    const config = minimalConfig();
    config.agent.sandbox = "host";
    const sandbox = createSandbox(config);
    expect(sandbox.kind).toBe("host");
  });

  it("createSandbox prefers per-agent sandbox over default", () => {
    const config = minimalConfig();
    config.agent.sandbox = "docker";
    // Provide required docker config so the factory doesn't throw
    config.sandboxes = { docker: { imageName: "node:22" } };
    const sandbox = createSandbox(config, { sandbox: "host" });
    expect(sandbox.kind).toBe("host");
  });
});

describe("sandbox factory registry — custom kind", () => {
  afterEach(() => {
    sandboxFactoryRegistry.unregister("my-custom-sandbox");
  });

  it("createSandbox resolves a custom registered kind", () => {
    registerSandboxFactory("my-custom-sandbox", () => fakeSandbox("my-custom-sandbox"));
    const sandbox = createSandbox(minimalConfig(), { sandbox: "my-custom-sandbox" });
    expect(sandbox.kind).toBe("my-custom-sandbox");
  });

  it("registered factory is listed in registry", () => {
    registerSandboxFactory("my-custom-sandbox", () => fakeSandbox("my-custom-sandbox"));
    expect(sandboxFactoryRegistry.list()).toContain("my-custom-sandbox");
  });
});

describe("sandbox factory registry — unknown kind", () => {
  it("throws a clear error with known kinds listed", () => {
    expect(() => createSandbox(minimalConfig(), { sandbox: "nonexistent-sandbox" })).toThrow(
      /Unknown sandbox kind "nonexistent-sandbox". Known:/,
    );
  });

  it("error message includes built-in kind names", () => {
    let message = "";
    try {
      createSandbox(minimalConfig(), { sandbox: "nonexistent-sandbox" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/host/);
  });
});

describe("sandbox factory registry — config validation", () => {
  it("validateConfig does not warn on unknown kinds (resolved at runtime)", async () => {
    const { validateConfig } = await import("../config.js");
    const config = minimalConfig();
    config.agent.sandbox = "firecracker";
    const ws = validateConfig(config);
    expect(ws.some((w) => w.toLowerCase().includes("firecracker"))).toBe(false);
  });

  it("validateConfig still warns when docker is selected without imageName", async () => {
    const { validateConfig } = await import("../config.js");
    const config = minimalConfig();
    config.agent.sandbox = "docker";
    const ws = validateConfig(config);
    expect(ws.some((w) => w.includes("sandboxes.docker.imageName is not set"))).toBe(true);
  });

  it("validateConfig still warns when podman is selected without imageName", async () => {
    const { validateConfig } = await import("../config.js");
    const config = minimalConfig();
    config.agent.sandbox = "podman";
    const ws = validateConfig(config);
    expect(ws.some((w) => w.includes("sandboxes.podman.imageName is not set"))).toBe(true);
  });
});
