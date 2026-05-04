import { describe, expect, it } from "vitest";
import { deepInterpolate, deepMerge, validateConfig, type AgentConfig } from "../config.js";

function baseConfig(): AgentConfig {
  return {
    server: { port: 3000, host: "0.0.0.0" },
    database: { path: "./agent.db" },
    providers: { ollama: { baseUrl: "http://localhost:11434", defaultModel: "x" } },
    agent: {
      defaultProvider: "ollama",
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

  it("warns when beads backend is selected (not implemented)", () => {
    const c = baseConfig();
    c.tasks = { backend: "beads" };
    expect(validateConfig(c).some((w) => w.includes(`"beads" is not yet implemented`))).toBe(true);
  });

  it("does not warn 'not implemented' for the beans backend", () => {
    const c = baseConfig();
    c.tasks = { backend: "beans" };
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

  it("warns about podman sandbox (not implemented)", () => {
    const c = baseConfig();
    c.agent.sandbox = "podman";
    expect(validateConfig(c).some((w) => w.includes(`agent.sandbox "podman" is not yet implemented`))).toBe(true);
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
    expect(ws.some((w) => w.includes(`Agent "pman" sandbox "podman" is not yet implemented`))).toBe(true);
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
