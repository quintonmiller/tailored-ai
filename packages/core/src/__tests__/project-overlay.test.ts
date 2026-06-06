import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../config.js";
import { loadConfig, mergeProjectOverlay } from "../config.js";
import { initDatabase } from "../db/schema.js";
import type { ProjectContext } from "../projects/resolve.js";
import { AgentRuntime } from "../runtime.js";
import type { Tool } from "../tools/interface.js";

let db: Database.Database;

beforeEach(() => {
  db = initDatabase(":memory:");
});

afterEach(() => {
  db.close();
});

function baseConfig(): AgentConfig {
  return loadConfig();
}

describe("mergeProjectOverlay", () => {
  it("returns base unchanged when overlay is empty/undefined", () => {
    const base = baseConfig();
    expect(mergeProjectOverlay(base, undefined)).toBe(base);
    expect(mergeProjectOverlay(base, null)).toBe(base);
    expect(mergeProjectOverlay(base, {})).toBe(base);
  });

  it("deep-merges scalar overrides", () => {
    const base = baseConfig();
    const merged = mergeProjectOverlay(base, {
      agent: { temperature: 0.9, maxToolRounds: 50 },
    });
    expect(merged.agent.temperature).toBe(0.9);
    expect(merged.agent.maxToolRounds).toBe(50);
    expect(merged.agent.defaultProvider).toBe(base.agent.defaultProvider);
  });

  it("adds new agents without losing existing ones", () => {
    const base = mergeProjectOverlay(baseConfig(), {
      agents: { existing: { instructions: "from base" } },
    });
    const merged = mergeProjectOverlay(base, {
      agents: { added: { instructions: "from overlay" } },
    });
    expect(merged.agents.existing.instructions).toBe("from base");
    expect(merged.agents.added.instructions).toBe("from overlay");
  });

  it("deep-merges a single agent's fields", () => {
    const base = mergeProjectOverlay(baseConfig(), {
      agents: { coder: { instructions: "global", temperature: 0.3, maxToolRounds: 5 } },
    });
    const merged = mergeProjectOverlay(base, {
      agents: { coder: { temperature: 0.9 } },
    });
    expect(merged.agents.coder.instructions).toBe("global");
    expect(merged.agents.coder.temperature).toBe(0.9);
    expect(merged.agents.coder.maxToolRounds).toBe(5);
  });

  it("replaces arrays wholesale (no concat)", () => {
    const base = mergeProjectOverlay(baseConfig(), {
      agents: { coder: { tools: ["read", "write", "exec"] } },
    });
    const merged = mergeProjectOverlay(base, {
      agents: { coder: { tools: ["read"] } },
    });
    expect(merged.agents.coder.tools).toEqual(["read"]);
  });

  it("interpolates ${ENV} references in the overlay before merging", () => {
    // Regression: a per-project `.tai.yaml` whose `tasks.github.token`
    // referenced ${GITHUB_PERSONAL_TOKEN} reached the github task backend
    // as the literal string `${GITHUB_PERSONAL_TOKEN}`, producing
    // "Bad credentials" on every Octokit call.
    process.env._OVERLAY_TEST_TOKEN = "ghp_secret_value";
    try {
      const base = baseConfig();
      const merged = mergeProjectOverlay(base, {
        tasks: {
          backend: "github",
          github: {
            repo: "acme/widgets",
            token: "${_OVERLAY_TEST_TOKEN}",
          },
        },
      });
      expect(merged.tasks?.github?.token).toBe("ghp_secret_value");
      expect(merged.tasks?.github?.repo).toBe("acme/widgets");
    } finally {
      delete process.env._OVERLAY_TEST_TOKEN;
    }
  });

  it("does not mutate the base config", () => {
    const base = baseConfig();
    const before = JSON.stringify(base);
    mergeProjectOverlay(base, { agent: { temperature: 0.99 } });
    expect(JSON.stringify(base)).toBe(before);
  });
});

describe("AgentRuntime + active project", () => {
  function buildRuntime(initialProject: ProjectContext | null): AgentRuntime {
    const config = baseConfig();
    const fakeProvider = { name: "fake", chat: async () => ({ message: { role: "assistant", content: "" } }) } as never;
    const fakeTool: Tool = {
      name: "fake",
      description: "fake",
      parameters: {},
      execute: async () => ({ success: true, output: "" }),
    };

    let toolsCalls = 0;
    let providerCalls = 0;
    const opts = {
      configPath: "/dev/null",
      db,
      contextDir: "/tmp",
      kbDir: "/tmp",
      createTools: (_cfg: AgentConfig) => {
        toolsCalls++;
        return [fakeTool];
      },
      createProvider: (_cfg: AgentConfig) => {
        providerCalls++;
        return { provider: fakeProvider, model: _cfg.providers?.openai_compatible?.defaultModel ?? "x" };
      },
    };
    const runtime = new AgentRuntime(opts, () => baseConfig(), config, initialProject);
    (runtime as unknown as { _toolsCalls: () => number })._toolsCalls = () => toolsCalls;
    (runtime as unknown as { _providerCalls: () => number })._providerCalls = () => providerCalls;
    return runtime;
  }

  it("starts with no active project by default", () => {
    const r = buildRuntime(null);
    expect(r.getActiveProject()).toBeNull();
    const cfg = r.getConfig();
    expect(cfg.agent.temperature).toBe(baseConfig().agent.temperature);
  });

  it("applies an initial project overlay during construction", () => {
    const ctx: ProjectContext = {
      id: "proj_test",
      name: "Test",
      path: "/repo",
      overlayPath: "/repo/.tai.yaml",
      overlay: { agent: { temperature: 0.99 } },
    };
    const r = buildRuntime(ctx);
    expect(r.getActiveProject()?.id).toBe("proj_test");
    expect(r.getConfig().agent.temperature).toBe(0.99);
  });

  it("setActiveProject triggers a reload and re-merges the overlay", () => {
    const r = buildRuntime(null);
    expect(r.getConfig().agent.temperature).toBe(baseConfig().agent.temperature);
    const gen0 = r.generation;

    const ctx: ProjectContext = {
      id: "proj_a",
      name: "A",
      path: "/a",
      overlayPath: "/a/.tai.yaml",
      overlay: { agent: { temperature: 0.1 } },
    };
    r.setActiveProject(ctx);
    expect(r.generation).toBe(gen0 + 1);
    expect(r.getConfig().agent.temperature).toBe(0.1);

    const ctxB: ProjectContext = {
      id: "proj_b",
      name: "B",
      path: "/b",
      overlayPath: "/b/.tai.yaml",
      overlay: { agent: { temperature: 0.7 } },
    };
    r.setActiveProject(ctxB);
    expect(r.getConfig().agent.temperature).toBe(0.7);

    r.setActiveProject(null);
    expect(r.getConfig().agent.temperature).toBe(baseConfig().agent.temperature);
  });

  it("validation warnings from the overlay are tagged with the project id on reload", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = buildRuntime(null);
    const ctx: ProjectContext = {
      id: "proj_bad",
      name: "Bad",
      path: "/bad",
      overlayPath: "/bad/.tai.yaml",
      overlay: {
        agents: { ghost: { instructions: "x", tools: ["nonexistent_tool"] } },
      },
    };
    r.setActiveProject(ctx);
    const all = warn.mock.calls.map((c) => String(c[0])).join("\n");
    warn.mockRestore();
    expect(all).toMatch(/\[project:proj_bad\] Warning:/);
    expect(all).toMatch(/nonexistent_tool/);
  });
});
