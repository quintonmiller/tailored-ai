import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentConfig, deepInterpolate, deepMerge, loadConfig, validateConfig } from "../config.js";

function baseConfig(): AgentConfig {
  return {
    server: { port: 3000, host: "0.0.0.0" },
    database: { path: "./agent.db" },
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
  };
}

describe("deepMerge", () => {
  it("merges flat objects", () => {
    const result = deepMerge({ a: 1, b: 2 }, { b: 3, c: 4 });
    expect(result).toEqual({ a: 1, b: 3, c: 4 });
  });

  it("deep merges nested objects", () => {
    const target = { server: { port: 3000, host: "0.0.0.0" } };
    const source = { server: { port: 8080 } };
    const result = deepMerge(
      target as unknown as Record<string, unknown>,
      source as unknown as Record<string, unknown>,
    );
    expect(result).toEqual({ server: { port: 8080, host: "0.0.0.0" } });
  });

  it("does not merge arrays — source replaces target", () => {
    const target = { items: [1, 2, 3] };
    const source = { items: [4, 5] };
    const result = deepMerge(
      target as unknown as Record<string, unknown>,
      source as unknown as Record<string, unknown>,
    );
    expect(result).toEqual({ items: [4, 5] });
  });

  it("does not mutate target", () => {
    const target = { a: { b: 1 } };
    const source = { a: { c: 2 } };
    deepMerge(target as unknown as Record<string, unknown>, source as unknown as Record<string, unknown>);
    expect(target).toEqual({ a: { b: 1 } });
  });

  it("handles empty source", () => {
    const target = { a: 1 };
    const result = deepMerge(target as unknown as Record<string, unknown>, {});
    expect(result).toEqual({ a: 1 });
  });
});

describe("deepInterpolate", () => {
  it("interpolates environment variables in strings", () => {
    process.env.TEST_VAR = "hello";
    const result = deepInterpolate("Value: ${TEST_VAR}");
    expect(result).toBe("Value: hello");
    delete process.env.TEST_VAR;
  });

  it("replaces missing env vars with empty string", () => {
    delete process.env.NONEXISTENT_VAR;
    const result = deepInterpolate("${NONEXISTENT_VAR}");
    expect(result).toBe("");
  });

  it("interpolates nested objects", () => {
    process.env.TEST_PORT = "8080";
    const result = deepInterpolate({ server: { port: "${TEST_PORT}" } });
    expect(result).toEqual({ server: { port: "8080" } });
    delete process.env.TEST_PORT;
  });

  it("interpolates arrays", () => {
    process.env.TEST_ITEM = "foo";
    const result = deepInterpolate(["${TEST_ITEM}", "bar"]);
    expect(result).toEqual(["foo", "bar"]);
    delete process.env.TEST_ITEM;
  });

  it("passes through non-string primitives", () => {
    expect(deepInterpolate(42)).toBe(42);
    expect(deepInterpolate(true)).toBe(true);
    expect(deepInterpolate(null)).toBe(null);
  });
});

describe("validateConfig — tasks block", () => {
  it("rejects unknown tasks.backend values", () => {
    const c = baseConfig();
    c.tasks = { backend: "trello" as unknown as "native" };
    const ws = validateConfig(c);
    expect(ws.some((w) => w.includes(`tasks.backend "trello" is not valid`))).toBe(true);
  });

  it("warns when github backend is missing repo and token", () => {
    const c = baseConfig();
    c.tasks = { backend: "github" };
    const ws = validateConfig(c);
    expect(ws.some((w) => w.includes("tasks.github.repo is not set"))).toBe(true);
    expect(ws.some((w) => w.includes("tasks.github.token is not set"))).toBe(true);
  });

  it("warns when github repo is malformed", () => {
    const c = baseConfig();
    c.tasks = { backend: "github", github: { repo: "not-a-repo", token: "x" } };
    const ws = validateConfig(c);
    expect(ws.some((w) => w.includes(`"not-a-repo" is not in "owner/repo" format`))).toBe(true);
  });

  it("accepts a valid github backend config", () => {
    const c = baseConfig();
    c.tasks = { backend: "github", github: { repo: "owner/repo", token: "t" } };
    const ws = validateConfig(c);
    expect(ws.some((w) => w.toLowerCase().includes("tasks."))).toBe(false);
  });

  it("does not warn 'not implemented' for beans or beads backends", () => {
    const c = baseConfig();
    c.tasks = { backend: "beans" };
    expect(validateConfig(c).some((w) => w.includes("not yet implemented"))).toBe(false);
    c.tasks = { backend: "beads" };
    expect(validateConfig(c).some((w) => w.includes("not yet implemented"))).toBe(false);
  });
});

describe("validateConfig — sandbox block", () => {
  it("rejects unknown sandbox kinds at agent.sandbox", () => {
    const c = baseConfig();
    c.agent.sandbox = "firecracker" as unknown as "host";
    const ws = validateConfig(c);
    expect(ws.some((w) => w.includes(`agent.sandbox "firecracker" is not valid`))).toBe(true);
  });

  it("warns when podman sandbox is selected without imageName", () => {
    const c = baseConfig();
    c.agent.sandbox = "podman";
    expect(validateConfig(c).some((w) => w.includes(`sandboxes.podman.imageName is not set`))).toBe(true);
  });

  it("does not warn when podman is selected with imageName", () => {
    const c = baseConfig();
    c.agent.sandbox = "podman";
    c.sandboxes = { podman: { imageName: "alpine" } };
    expect(validateConfig(c).some((w) => w.toLowerCase().includes("podman"))).toBe(false);
  });

  it("warns when docker sandbox is selected without imageName", () => {
    const c = baseConfig();
    c.agent.sandbox = "docker";
    expect(validateConfig(c).some((w) => w.includes(`sandboxes.docker.imageName is not set`))).toBe(true);
  });

  it("does not warn when docker is selected with imageName", () => {
    const c = baseConfig();
    c.agent.sandbox = "docker";
    c.sandboxes = { docker: { imageName: "alpine" } };
    expect(validateConfig(c).some((w) => w.toLowerCase().includes("sandbox"))).toBe(false);
  });

  it("validates per-agent sandbox overrides", () => {
    const c = baseConfig();
    c.agents = {
      coder: { sandbox: "docker" },
      bad: { sandbox: "wat" as unknown as "host" },
      pman: { sandbox: "podman" },
    };
    const ws = validateConfig(c);
    expect(ws.some((w) => w.includes(`Agent "coder" uses sandbox "docker"`))).toBe(true);
    expect(ws.some((w) => w.includes(`Agent "bad" sandbox "wat" is not valid`))).toBe(true);
    expect(ws.some((w) => w.includes(`Agent "pman" uses sandbox "podman"`))).toBe(true);
  });
});

describe("validateConfig — prompts block", () => {
  it("rejects non-positive maxIncludeDepth", () => {
    const c = baseConfig();
    c.prompts = { maxIncludeDepth: 0 };
    expect(validateConfig(c).some((w) => w.includes("maxIncludeDepth"))).toBe(true);
    c.prompts = { maxIncludeDepth: -1 };
    expect(validateConfig(c).some((w) => w.includes("maxIncludeDepth"))).toBe(true);
    c.prompts = { maxIncludeDepth: 1.5 };
    expect(validateConfig(c).some((w) => w.includes("maxIncludeDepth"))).toBe(true);
  });

  it("rejects non-positive shellTimeoutMs", () => {
    const c = baseConfig();
    c.prompts = { shellTimeoutMs: 0 };
    expect(validateConfig(c).some((w) => w.includes("shellTimeoutMs"))).toBe(true);
    c.prompts = { shellTimeoutMs: -100 };
    expect(validateConfig(c).some((w) => w.includes("shellTimeoutMs"))).toBe(true);
  });

  it("accepts valid prompts settings", () => {
    const c = baseConfig();
    c.prompts = { maxIncludeDepth: 3, shellTimeoutMs: 1000, allowShellExpansion: true };
    expect(validateConfig(c).some((w) => w.toLowerCase().includes("prompts."))).toBe(false);
  });
});

describe("validateConfig — online (exploratory) agents", () => {
  it("warns when online.enabled is set but recall is missing from tools", () => {
    const c = baseConfig();
    c.agents = {
      watcher: {
        tools: ["web_search", "web_fetch"],
        online: { enabled: true },
      },
    };
    const ws = validateConfig(c);
    expect(ws.some((w) => w.includes("watcher") && w.includes('does not include "recall"'))).toBe(true);
  });

  it("does not warn when online.enabled but the agent has recall", () => {
    const c = baseConfig();
    c.agents = {
      watcher: {
        tools: ["recall", "web_search"],
        online: { enabled: true },
      },
    };
    const ws = validateConfig(c);
    expect(ws.some((w) => w.includes('does not include "recall"'))).toBe(false);
  });

  it("does not warn when online is disabled", () => {
    const c = baseConfig();
    c.agents = {
      watcher: { tools: ["web_search"], online: { enabled: false } },
    };
    expect(validateConfig(c).some((w) => w.includes("online"))).toBe(false);
  });

  it("warns when online.tools contains entries outside the agent's tool list", () => {
    const c = baseConfig();
    c.agents = {
      watcher: {
        tools: ["recall", "web_search"],
        online: { enabled: true, tools: ["recall", "exec"] },
      },
    };
    const ws = validateConfig(c);
    expect(ws.some((w) => w.includes("watcher") && w.includes('"exec"') && w.includes("main tools list"))).toBe(true);
  });

  it("warns when cadence.interval_minutes is non-positive", () => {
    const c = baseConfig();
    c.agents = {
      watcher: {
        tools: ["recall"],
        online: { enabled: true, cadence: { interval_minutes: 0 } },
      },
    };
    expect(validateConfig(c).some((w) => w.includes("interval_minutes must be > 0"))).toBe(true);
  });

  it("warns when max_interval_minutes is below interval_minutes", () => {
    const c = baseConfig();
    c.agents = {
      watcher: {
        tools: ["recall"],
        online: {
          enabled: true,
          cadence: { interval_minutes: 60, max_interval_minutes: 30 },
        },
      },
    };
    expect(validateConfig(c).some((w) => w.includes("max_interval_minutes"))).toBe(true);
  });

  it("warns when cadence.window uses bad HH:MM strings", () => {
    const c = baseConfig();
    c.agents = {
      watcher: {
        tools: ["recall"],
        online: {
          enabled: true,
          cadence: { window: { start: "9am", end: "18:00" } },
        },
      },
    };
    expect(validateConfig(c).some((w) => w.includes("HH:MM"))).toBe(true);
  });
});

describe("validateConfig — server exposure warning", () => {
  it("warns when host is 0.0.0.0 without auth", () => {
    const c = baseConfig();
    const warnings = validateConfig(c);
    expect(warnings.some((w) => w.includes('server.host="0.0.0.0"'))).toBe(true);
  });

  it("does not warn when bound to 127.0.0.1", () => {
    const c = { ...baseConfig(), server: { port: 3000, host: "127.0.0.1" } };
    const warnings = validateConfig(c);
    expect(warnings.some((w) => w.includes("server.host"))).toBe(false);
  });

  it("does not warn when authToken is set", () => {
    const c = { ...baseConfig(), server: { port: 3000, host: "0.0.0.0", authToken: "x" } };
    const warnings = validateConfig(c);
    expect(warnings.some((w) => w.includes("server.host"))).toBe(false);
  });

  it("does not warn when proxyAuth is enabled", () => {
    const c = {
      ...baseConfig(),
      server: { port: 3000, host: "0.0.0.0", proxyAuth: { enabled: true, password: "p" } },
    };
    const warnings = validateConfig(c);
    expect(warnings.some((w) => w.includes("server.host"))).toBe(false);
  });

  it("warns when apiKey is set but no authToken (apiKey only gates mutations)", () => {
    const c = { ...baseConfig(), server: { port: 3000, host: "0.0.0.0", apiKey: "k" } };
    const warnings = validateConfig(c);
    expect(warnings.some((w) => w.includes("server.host"))).toBe(true);
  });
});

describe("loadConfig — ollama back-compat shim", () => {
  let dir: string;
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tai-config-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    warnSpy.mockRestore();
  });
  beforeEach(() => {
    warnSpy.mockClear();
  });

  it("translates providers.ollama into providers.openai_compatible with /v1 appended", () => {
    const path = join(dir, "config-ollama.yaml");
    writeFileSync(
      path,
      [
        "providers:",
        "  ollama:",
        "    baseUrl: http://localhost:11434",
        "    defaultModel: my-model",
        "agent:",
        "  defaultProvider: ollama",
        '  extraInstructions: ""',
        "  maxHistoryTokens: 2000",
        "  temperature: 0.3",
        "  maxToolRounds: 10",
      ].join("\n"),
      "utf-8",
    );

    const config = loadConfig(path);
    expect((config.providers as Record<string, unknown>).ollama).toBeUndefined();
    expect(config.providers.openai_compatible).toEqual({
      baseUrl: "http://localhost:11434/v1",
      defaultModel: "my-model",
      name: "Ollama",
    });
    expect(config.agent.defaultProvider).toBe("openai_compatible");
    expect(warnSpy.mock.calls.some((args) => String(args[0]).includes("providers.ollama is deprecated"))).toBe(true);
  });

  it("preserves /v1 suffix when already present", () => {
    const path = join(dir, "config-ollama-v1.yaml");
    writeFileSync(
      path,
      [
        "providers:",
        "  ollama:",
        "    baseUrl: http://localhost:11434/v1",
        "    defaultModel: m",
        "agent:",
        "  defaultProvider: ollama",
      ].join("\n"),
      "utf-8",
    );

    const config = loadConfig(path);
    expect(config.providers.openai_compatible?.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("does not clobber an explicit openai_compatible block", () => {
    const path = join(dir, "config-both.yaml");
    writeFileSync(
      path,
      [
        "providers:",
        "  ollama:",
        "    baseUrl: http://localhost:11434",
        "    defaultModel: old",
        "  openai_compatible:",
        "    baseUrl: http://127.0.0.1:8000/v1",
        "    defaultModel: vllm-llama",
        "agent:",
        "  defaultProvider: openai_compatible",
      ].join("\n"),
      "utf-8",
    );

    const config = loadConfig(path);
    expect((config.providers as Record<string, unknown>).ollama).toBeUndefined();
    expect(config.providers.openai_compatible).toEqual({
      baseUrl: "http://127.0.0.1:8000/v1",
      defaultModel: "vllm-llama",
    });
  });

  it("translates a stale defaultProvider: ollama even without a providers.ollama block", () => {
    const path = join(dir, "config-stale-default.yaml");
    writeFileSync(
      path,
      [
        "providers:",
        "  openai_compatible:",
        "    baseUrl: http://127.0.0.1:8000/v1",
        "    defaultModel: m",
        "agent:",
        "  defaultProvider: ollama",
      ].join("\n"),
      "utf-8",
    );

    const config = loadConfig(path);
    expect(config.agent.defaultProvider).toBe("openai_compatible");
  });
});
