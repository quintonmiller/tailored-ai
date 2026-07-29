import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { warnIfContextIsLarge } from "../agent/loop.js";
import {
  type AgentConfig,
  DEFAULT_DISABLED_PLUGIN_MODULES,
  DEFAULT_PLUGIN_MODULES,
  deepInterpolate,
  deepMerge,
  loadConfig,
  migrateDefaultPlugins,
  migrateDeliveryConfig,
  migrateTaskBackendConfig,
  validateConfig,
} from "../config.js";

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
  // Task backends are no longer special-cased here: the id is an open
  // registry key (createTaskBackend throws a dynamic "Known: …" error on an
  // unknown name) and backend-specific options are the backend's concern.
  // So validateConfig privileges no built-in and emits no tasks.* warnings.
  it("does not warn on an unknown task backend (resolved at construction, not here)", () => {
    const c = baseConfig();
    c.tasks = { backend: "trello" };
    expect(validateConfig(c).some((w) => w.toLowerCase().includes("tasks.backend"))).toBe(false);
  });

  it("does not emit github-specific warnings (no privileged built-in)", () => {
    const c = baseConfig();
    c.tasks = { backend: "github" };
    expect(validateConfig(c).some((w) => w.toLowerCase().includes("tasks.github"))).toBe(false);
  });

  it("does not warn for beans or beads backends", () => {
    const c = baseConfig();
    c.tasks = { backend: "beans" };
    expect(validateConfig(c).some((w) => w.toLowerCase().includes("tasks."))).toBe(false);
    c.tasks = { backend: "beads" };
    expect(validateConfig(c).some((w) => w.toLowerCase().includes("tasks."))).toBe(false);
  });
});

describe("validateConfig — tool references", () => {
  it("does not warn for task_query when tasks is enabled (they register together)", () => {
    const c = baseConfig();
    c.tools = { tasks: { enabled: true } };
    c.agents = { coder: { tools: ["tasks", "task_query"] } };
    expect(validateConfig(c).some((w) => w.includes("task_query"))).toBe(false);
  });

  it("still warns for task_query when tasks is disabled", () => {
    const c = baseConfig();
    c.tools = { tasks: { enabled: false } };
    c.agents = { coder: { tools: ["task_query"] } };
    expect(validateConfig(c).some((w) => w.includes('references tool "task_query"'))).toBe(true);
  });

  it("warns for a genuinely unknown tool reference", () => {
    const c = baseConfig();
    c.agents = { coder: { tools: ["nonexistent_tool"] } };
    expect(validateConfig(c).some((w) => w.includes('references tool "nonexistent_tool"'))).toBe(true);
  });

  it("names an unknown key inside an agent block, and guesses the right one", () => {
    // Top-level keys have been checked since #252, but agent blocks were left
    // open. Four agents carried their entire persona under `system_prompt:`
    // instead of `instructions:` — it parsed, it round-tripped into their
    // manifests, and it reached nothing. They ran with an empty instructions
    // layer for weeks with no warning anywhere.
    const c = baseConfig();
    c.agents = { generalist: { system_prompt: "You are a generalist." } as never };

    const warnings = validateConfig(c);

    expect(warnings.some((w) => w.includes('unknown key "system_prompt"'))).toBe(true);
    expect(warnings.some((w) => w.includes('Did you mean "systemPrompt"'))).toBe(true);
  });

  it("keeps the context-size warning configurable, so a deliberate choice can silence it", () => {
    // A warning that fires on a correct configuration teaches people to ignore
    // the whole class. A deployment running large, specific context on a long
    // context window is making a choice, not a mistake.
    const big = "x".repeat(40_000);

    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (m: string) => warnings.push(m);
    try {
      warnIfContextIsLarge(big, "coder", 0);
      expect(warnings).toEqual([]);

      warnIfContextIsLarge(big, "planner", 100);
      expect(warnings.some((w) => w.includes("context.warnTokens"))).toBe(true);
    } finally {
      console.warn = original;
    }
  });

  it("recognises an abbreviation, which edit distance alone cannot", () => {
    // Found in the wild: an agent authored `temp: 0.3` into its own config and
    // ran at the default temperature instead. "temp" is seven edits from
    // "temperature" and obviously means it.
    const c = baseConfig();
    c.agents = { "job-search-coordinator": { temp: 0.3 } as never };

    expect(validateConfig(c).some((w) => w.includes('Did you mean "temperature"'))).toBe(true);
  });

  it("does not treat a two-character key as an abbreviation of anything", () => {
    const c = baseConfig();
    c.agents = { coder: { on: true } as never };

    const warnings = validateConfig(c).filter((w) => w.includes('unknown key "on"'));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain("Did you mean");
  });

  it("does not guess when the key resembles nothing", () => {
    const c = baseConfig();
    c.agents = { coder: { wibble: 1 } as never };

    const warnings = validateConfig(c).filter((w) => w.includes('unknown key "wibble"'));

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain("Did you mean");
  });

  it("stays quiet about every real agent key", () => {
    // The guard is only useful if it does not cry wolf; a false warning on a
    // correct key teaches people to ignore the whole class.
    const c = baseConfig();
    c.agents = {
      full: {
        description: "d",
        instructions: "i",
        tools: ["read"],
        temperature: 0.3,
        maxToolRounds: 5,
        fileBoundary: "/tmp",
        roomSessionScope: "shared",
        injectMemory: true,
        budgetWarnings: true,
        skipGlobalContext: true,
        summarizeOnTrim: true,
        worktree: true,
        skills: ["x"],
        skillLoading: "progressive",
        systemPrompt: { base: "b" },
      } as never,
    };

    expect(validateConfig(c).filter((w) => w.includes("unknown key"))).toEqual([]);
  });
});

describe("validateConfig — dashboard widgets", () => {
  it("does not warn for valid widgets", () => {
    const c = baseConfig();
    c.dashboard = { widgets: [{ id: "a", type: "tasks", options: { endpoint: "/api/project-tasks" } }] };
    expect(validateConfig(c).some((w) => w.startsWith("dashboard.widgets"))).toBe(false);
  });

  it("warns on a malformed widget (missing type) and a non-/api endpoint", () => {
    const c = baseConfig();
    c.dashboard = {
      widgets: [{ id: "bad" } as never, { id: "ext", type: "list", options: { endpoint: "https://evil.example" } }],
    };
    const ws = validateConfig(c).filter((w) => w.startsWith("dashboard.widgets"));
    expect(ws.some((w) => w.includes("`type`"))).toBe(true);
    expect(ws.some((w) => w.includes("/api/"))).toBe(true);
  });

  it("warns on duplicate widget ids", () => {
    const c = baseConfig();
    c.dashboard = {
      widgets: [
        { id: "dup", type: "list" },
        { id: "dup", type: "tasks" },
      ],
    };
    expect(validateConfig(c).some((w) => w.includes('duplicate widget id "dup"'))).toBe(true);
  });
});

describe("validateConfig — dashboard widgets", () => {
  it("does not warn for valid widgets", () => {
    const c = baseConfig();
    c.dashboard = { widgets: [{ id: "a", type: "tasks", options: { endpoint: "/api/project-tasks" } }] };
    expect(validateConfig(c).some((w) => w.startsWith("dashboard.widgets"))).toBe(false);
  });

  it("warns on a malformed widget (missing type) and a non-/api endpoint", () => {
    const c = baseConfig();
    c.dashboard = {
      widgets: [{ id: "bad" } as never, { id: "ext", type: "list", options: { endpoint: "https://evil.example" } }],
    };
    const ws = validateConfig(c).filter((w) => w.startsWith("dashboard.widgets"));
    expect(ws.some((w) => w.includes("`type`"))).toBe(true);
    expect(ws.some((w) => w.includes("/api/"))).toBe(true);
  });

  it("warns on duplicate widget ids", () => {
    const c = baseConfig();
    c.dashboard = {
      widgets: [
        { id: "dup", type: "list" },
        { id: "dup", type: "tasks" },
      ],
    };
    expect(validateConfig(c).some((w) => w.includes('duplicate widget id "dup"'))).toBe(true);
  });
});

describe("migrateTaskBackendConfig — legacy per-backend blocks → tasks.options", () => {
  it("folds tasks.github into tasks.options and deletes the legacy block", () => {
    const cfg = { tasks: { backend: "github", github: { repo: "a/r", token: "t", agentRoles: ["coder"] } } };
    migrateTaskBackendConfig(cfg);
    expect(cfg.tasks).toEqual({ backend: "github", options: { repo: "a/r", token: "t", agentRoles: ["coder"] } });
  });

  it("folds beans/beads path the same way", () => {
    const beans: Record<string, unknown> = { tasks: { backend: "beans", beans: { path: "/x/beans.json" } } };
    migrateTaskBackendConfig(beans);
    expect(beans.tasks).toEqual({ backend: "beans", options: { path: "/x/beans.json" } });
  });

  it("lets an explicit tasks.options win over the legacy block", () => {
    const cfg = {
      tasks: { backend: "github", options: { repo: "new/repo" }, github: { repo: "old/repo", token: "t" } },
    };
    migrateTaskBackendConfig(cfg);
    expect((cfg.tasks as { options: Record<string, unknown> }).options).toEqual({ repo: "new/repo", token: "t" });
  });

  it("is a no-op when there is no legacy block", () => {
    const cfg = { tasks: { backend: "native" } };
    migrateTaskBackendConfig(cfg);
    expect(cfg.tasks).toEqual({ backend: "native" });
  });

  it("is a no-op when there is no tasks block", () => {
    const cfg: Record<string, unknown> = { agent: {} };
    migrateTaskBackendConfig(cfg);
    expect(cfg).toEqual({ agent: {} });
  });
});

describe("migrateDeliveryConfig — legacy delivery.channel union → { channel, mode }", () => {
  it("maps taskWatcher delivery 'discord' to channel + channel mode, preserving target", () => {
    const cfg = { taskWatcher: { delivery: { channel: "discord", target: "room-1" } } };
    migrateDeliveryConfig(cfg);
    expect(cfg.taskWatcher.delivery).toEqual({ channel: "discord", mode: "channel", target: "room-1" });
  });

  it("maps taskWatcher delivery 'discord-dm' to channel 'discord' + dm mode, preserving target", () => {
    const cfg = { taskWatcher: { delivery: { channel: "discord-dm", target: "user-1" } } };
    migrateDeliveryConfig(cfg);
    expect(cfg.taskWatcher.delivery).toEqual({ channel: "discord", mode: "dm", target: "user-1" });
  });

  it("leaves 'log' delivery as the console sentinel (no mode added)", () => {
    const cfg = { taskWatcher: { delivery: { channel: "log" } } };
    migrateDeliveryConfig(cfg);
    expect(cfg.taskWatcher.delivery).toEqual({ channel: "log" });
  });

  it("maps each cron job's legacy delivery independently", () => {
    const cfg = {
      cron: {
        jobs: [
          { name: "a", delivery: { channel: "discord", target: "room-a" } },
          { name: "b", delivery: { channel: "discord-dm" } },
          { name: "c", delivery: { channel: "log" } },
          { name: "d" },
        ],
      },
    };
    migrateDeliveryConfig(cfg);
    expect(cfg.cron.jobs[0].delivery).toEqual({ channel: "discord", mode: "channel", target: "room-a" });
    expect(cfg.cron.jobs[1].delivery).toEqual({ channel: "discord", mode: "dm" });
    expect(cfg.cron.jobs[2].delivery).toEqual({ channel: "log" });
    expect(cfg.cron.jobs[3].delivery).toBeUndefined();
  });

  it("is idempotent — already-migrated config is left untouched", () => {
    const cfg = {
      taskWatcher: { delivery: { channel: "discord", mode: "dm", target: "user-1" } },
      cron: { jobs: [{ name: "a", delivery: { channel: "slack", mode: "channel", target: "C123" } }] },
    };
    const before = JSON.parse(JSON.stringify(cfg));
    migrateDeliveryConfig(cfg);
    expect(cfg).toEqual(before);
  });

  it("leaves an already-open custom channel id untouched", () => {
    const cfg = { taskWatcher: { delivery: { channel: "slack", target: "C42" } } };
    migrateDeliveryConfig(cfg);
    // No legacy string match and no mode → left exactly as written.
    expect(cfg.taskWatcher.delivery).toEqual({ channel: "slack", target: "C42" });
  });

  it("is a no-op when there is no taskWatcher or cron block", () => {
    const cfg: Record<string, unknown> = { agent: {} };
    migrateDeliveryConfig(cfg);
    expect(cfg).toEqual({ agent: {} });
  });
});

describe("migrateDefaultPlugins — seed missing builtin: entries", () => {
  const modules = (entries: AgentConfig["plugins"]) =>
    (entries ?? []).map((e) => (typeof e === "string" ? e : e.module));

  it("appends all builtins (enabled set, then disabled set) to an empty/undefined plugins array", () => {
    const cfg = baseConfig();
    cfg.plugins = [];
    migrateDefaultPlugins(cfg);
    expect(modules(cfg.plugins)).toEqual([...DEFAULT_PLUGIN_MODULES, ...DEFAULT_DISABLED_PLUGIN_MODULES]);
  });

  it("seeds the disabled built-in set with enabled: false", () => {
    const cfg = baseConfig();
    cfg.plugins = [];
    migrateDefaultPlugins(cfg);
    for (const module of DEFAULT_DISABLED_PLUGIN_MODULES) {
      const entry = (cfg.plugins ?? []).find((e) => typeof e !== "string" && e.module === module);
      expect(entry).toEqual({ module, enabled: false });
    }
  });

  it("preserves user entries and appends missing builtins AFTER them", () => {
    const cfg = baseConfig();
    cfg.plugins = ["@me/my-plugin", "builtin:stall-guard"];
    migrateDefaultPlugins(cfg);
    expect(modules(cfg.plugins)).toEqual([
      "@me/my-plugin",
      "builtin:stall-guard",
      // the enabled defaults not already present, in default order
      "builtin:agent-notifier",
      "builtin:owner-notifier",
      "builtin:scope-creep-flagger",
      "builtin:coder-project-guard",
      // then the disabled set
      ...DEFAULT_DISABLED_PLUGIN_MODULES,
    ]);
  });

  it("does NOT flip a user-enabled opt-in built-in back to disabled", () => {
    const cfg = baseConfig();
    // User has opted the session-summarizer in.
    cfg.plugins = [{ module: "builtin:session-summarizer", enabled: true, config: { intervalMinutes: 10 } }];
    migrateDefaultPlugins(cfg);
    const entry = (cfg.plugins ?? []).find((e) => typeof e !== "string" && e.module === "builtin:session-summarizer");
    // The existing entry is left untouched — opt-in survives the migration.
    expect(entry).toEqual({ module: "builtin:session-summarizer", enabled: true, config: { intervalMinutes: 10 } });
    // And it appears exactly once (not re-appended).
    expect(modules(cfg.plugins).filter((m) => m === "builtin:session-summarizer")).toHaveLength(1);
  });

  it("is idempotent — running twice does not duplicate", () => {
    const cfg = baseConfig();
    cfg.plugins = ["@me/my-plugin"];
    migrateDefaultPlugins(cfg);
    const once = modules(cfg.plugins);
    migrateDefaultPlugins(cfg);
    expect(modules(cfg.plugins)).toEqual(once);
  });

  it("respects a present-but-disabled builtin (does not re-add it)", () => {
    const cfg = baseConfig();
    cfg.plugins = [{ module: "builtin:scope-creep-flagger", enabled: false }];
    migrateDefaultPlugins(cfg);
    // Disabled entry stays exactly once; only the other three are appended.
    const disabled = (cfg.plugins ?? []).filter(
      (e) => typeof e !== "string" && e.module === "builtin:scope-creep-flagger",
    );
    expect(disabled).toEqual([{ module: "builtin:scope-creep-flagger", enabled: false }]);
    expect(modules(cfg.plugins)).toHaveLength(DEFAULT_PLUGIN_MODULES.length + DEFAULT_DISABLED_PLUGIN_MODULES.length);
  });

  it("matches builtins declared in the object form", () => {
    const cfg = baseConfig();
    cfg.plugins = [
      ...DEFAULT_PLUGIN_MODULES.map((module) => ({ module })),
      ...DEFAULT_DISABLED_PLUGIN_MODULES.map((module) => ({ module, enabled: false })),
    ];
    migrateDefaultPlugins(cfg);
    expect(modules(cfg.plugins)).toEqual([...DEFAULT_PLUGIN_MODULES, ...DEFAULT_DISABLED_PLUGIN_MODULES]);
  });

  it("rewrites the renamed builtin:discord-notifier → builtin:agent-notifier (string form)", () => {
    const cfg = baseConfig();
    cfg.plugins = ["builtin:discord-notifier"];
    migrateDefaultPlugins(cfg);
    expect(modules(cfg.plugins)).toContain("builtin:agent-notifier");
    expect(modules(cfg.plugins)).not.toContain("builtin:discord-notifier");
    // No duplicate agent-notifier appended afterward.
    expect(modules(cfg.plugins).filter((m) => m === "builtin:agent-notifier")).toHaveLength(1);
  });

  it("rewrites the renamed builtin preserving enabled/config (object form)", () => {
    const cfg = baseConfig();
    cfg.plugins = [{ module: "builtin:discord-notifier", enabled: false, config: { foo: 1 } }];
    migrateDefaultPlugins(cfg);
    const entry = (cfg.plugins ?? []).find((e) => typeof e !== "string" && e.module === "builtin:agent-notifier");
    expect(entry).toEqual({ module: "builtin:agent-notifier", enabled: false, config: { foo: 1 } });
    expect(modules(cfg.plugins)).not.toContain("builtin:discord-notifier");
  });
});

describe("validateConfig — sandbox block", () => {
  it("does not warn on unknown sandbox kinds — resolved dynamically via registry", () => {
    const c = baseConfig();
    c.agent.sandbox = "firecracker";
    const ws = validateConfig(c);
    // Unknown kinds are caught at runtime by createSandbox, not at config-load
    // time, so plugins can register additional kinds after config validation runs.
    expect(ws.some((w) => w.toLowerCase().includes("firecracker"))).toBe(false);
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

  it("validates per-agent sandbox overrides (docker/podman imageName checks)", () => {
    const c = baseConfig();
    c.agents = {
      coder: { sandbox: "docker" },
      // "wat" is an unknown kind — no warning at config time (registry resolves at runtime)
      custom: { sandbox: "firecracker" },
      pman: { sandbox: "podman" },
    };
    const ws = validateConfig(c);
    expect(ws.some((w) => w.includes(`Agent "coder" uses sandbox "docker"`))).toBe(true);
    expect(ws.some((w) => w.includes(`Agent "pman" uses sandbox "podman"`))).toBe(true);
    // Unknown kinds produce no warning — they are resolved via the registry at runtime.
    expect(ws.some((w) => w.toLowerCase().includes("firecracker"))).toBe(false);
  });
});

describe("validateConfig — unknown top-level keys (#252)", () => {
  const unknownKeyWarnings = (c: AgentConfig) => validateConfig(c).filter((w) => w.includes("unknown top-level key"));

  it("warns once on an unrecognized top-level key, naming it", () => {
    const c = baseConfig();
    (c as unknown as Record<string, unknown>).mpc = { servers: {} }; // typo for "mcp"
    const ws = unknownKeyWarnings(c);
    expect(ws).toHaveLength(1);
    expect(ws[0]).toContain('"mpc"');
    expect(ws[0]).toContain("Supported keys:");
    // The hint should mention version skew so a user on an older build understands.
    expect(ws[0].toLowerCase()).toContain("version");
  });

  it("does not warn on a clean config (all top-level keys recognized)", () => {
    expect(unknownKeyWarnings(baseConfig())).toHaveLength(0);
  });

  it("does not warn on optional typed keys absent from DEFAULT_CONFIG", () => {
    const c = baseConfig();
    c.permissions = { allowedPaths: [] } as never;
    c.memory = { embeddings: { enabled: false } } as never;
    c.security = {} as never;
    expect(unknownKeyWarnings(c)).toHaveLength(0);
  });

  it("tolerates the deprecated 'profiles' key (loadConfig migrates + warns for it)", () => {
    const c = baseConfig();
    (c as unknown as Record<string, unknown>).profiles = {};
    expect(unknownKeyWarnings(c)).toHaveLength(0);
  });

  it("only checks the top level — unknown nested keys in open bags are fine", () => {
    const c = baseConfig();
    c.tools = { ...c.tools, some_future_tool: { enabled: true } } as never;
    c.providers = { ...c.providers, groq: { baseUrl: "https://api.groq.com/openai/v1", defaultModel: "m" } };
    c.channels = { ...c.channels, telegram: { enabled: true } } as never;
    expect(unknownKeyWarnings(c)).toHaveLength(0);
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

describe("loadConfig — default host", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tai-config-host-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults server.host to 127.0.0.1 when no config file exists", () => {
    const cfg = loadConfig(join(dir, "missing.yaml"));
    expect(cfg.server.host).toBe("127.0.0.1");
  });

  it("respects an explicit host: 0.0.0.0 in the config file", () => {
    const path = join(dir, "exposed.yaml");
    writeFileSync(path, "server:\n  port: 3000\n  host: 0.0.0.0\n");
    const cfg = loadConfig(path);
    expect(cfg.server.host).toBe("0.0.0.0");
  });

  it("seeds the default builtin plugins (enabled set + disabled opt-ins) when no config file exists", () => {
    const cfg = loadConfig(join(dir, "no-such.yaml"));
    const mods = (cfg.plugins ?? []).map((e) => (typeof e === "string" ? e : e.module));
    expect(mods).toEqual([...DEFAULT_PLUGIN_MODULES, ...DEFAULT_DISABLED_PLUGIN_MODULES]);
    // The opt-in built-ins ship disabled.
    for (const module of DEFAULT_DISABLED_PLUGIN_MODULES) {
      expect(cfg.plugins?.find((e) => typeof e !== "string" && e.module === module)).toEqual({
        module,
        enabled: false,
      });
    }
  });

  it("appends missing default plugins after a user's plugins: block", () => {
    const path = join(dir, "user-plugins.yaml");
    writeFileSync(path, "plugins:\n  - '@me/custom'\n  - module: 'builtin:stall-guard'\n    enabled: false\n");
    const cfg = loadConfig(path);
    const mods = (cfg.plugins ?? []).map((e) => (typeof e === "string" ? e : e.module));
    // User entries first, then the enabled set not already present, then the disabled opt-ins.
    expect(mods).toEqual([
      "@me/custom",
      "builtin:stall-guard",
      "builtin:agent-notifier",
      "builtin:owner-notifier",
      "builtin:scope-creep-flagger",
      "builtin:coder-project-guard",
      ...DEFAULT_DISABLED_PLUGIN_MODULES,
    ]);
    // The disabled stall-guard is preserved as-is (durable off switch).
    expect(cfg.plugins?.[1]).toEqual({ module: "builtin:stall-guard", enabled: false });
  });

  it("migrates the legacy tools.discord_dm key to tools.notify_owner", () => {
    const path = join(dir, "discord-dm.yaml");
    writeFileSync(path, "tools:\n  discord_dm:\n    enabled: true\n");
    const cfg = loadConfig(path);
    expect(cfg.tools.notify_owner).toEqual({ enabled: true });
    expect((cfg.tools as Record<string, unknown>).discord_dm).toBeUndefined();
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

describe("validateConfig — mcp block", () => {
  it("accepts a server with exactly one transport", () => {
    const c = baseConfig();
    c.mcp = { servers: { gh: { command: "npx", args: ["-y", "some-mcp-server"] } } };
    expect(validateConfig(c).some((w) => w.includes("mcp.servers"))).toBe(false);
  });

  it("warns when a server has neither command nor url", () => {
    const c = baseConfig();
    c.mcp = { servers: { broken: {} } };
    expect(validateConfig(c).some((w) => w.includes("mcp.servers.broken"))).toBe(true);
  });

  it("warns when a server sets both command and url", () => {
    const c = baseConfig();
    c.mcp = { servers: { both: { command: "npx", url: "http://localhost:3001/mcp" } } };
    expect(validateConfig(c).some((w) => w.includes("mcp.servers.both"))).toBe(true);
  });

  it("ignores disabled server entries", () => {
    const c = baseConfig();
    c.mcp = { servers: { off: { enabled: false } } };
    expect(validateConfig(c).some((w) => w.includes("mcp.servers"))).toBe(false);
  });

  it("skips static validation of mcp_ agent tool refs when a server is configured", () => {
    const c = baseConfig();
    c.mcp = { servers: { gh: { command: "npx" } } };
    c.agents = { helper: { tools: ["mcp_gh_search"] } };
    expect(validateConfig(c).some((w) => w.includes("mcp_gh_search"))).toBe(false);
  });

  it("warns on mcp_ agent tool refs when no servers are configured", () => {
    const c = baseConfig();
    c.agents = { helper: { tools: ["mcp_gh_search"] } };
    expect(validateConfig(c).some((w) => w.includes("mcp_gh_search"))).toBe(true);
  });
});

describe("agent tools written as a JSON string", () => {
  it("parses a JSON-array string into a real list", () => {
    // What an agent creating another agent actually writes. A string is
    // iterable, so leaving it meant resolveAgent walked it character by
    // character and failed on `unknown tool "["` — days later, at first use.
    const dir = mkdtempSync(join(tmpdir(), "tai-agent-tools-"));
    const path = join(dir, "config.yaml");
    writeFileSync(path, 'agents:\n  generalist:\n    tools: \'["read", "memory"]\'\n    skills: \'["a"]\'\n');

    const config = loadConfig(path);

    expect(config.agents?.generalist?.tools).toEqual(["read", "memory"]);
    expect(config.agents?.generalist?.skills).toEqual(["a"]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("leaves a non-JSON string alone and reports it by name", () => {
    const dir = mkdtempSync(join(tmpdir(), "tai-agent-tools-"));
    const path = join(dir, "config.yaml");
    writeFileSync(path, "agents:\n  broken:\n    tools: read, memory\n");

    const warnings = validateConfig(loadConfig(path));

    expect(warnings.some((w) => w.includes("agents.broken.tools") && w.includes("list"))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("says nothing about a well-formed list", () => {
    const dir = mkdtempSync(join(tmpdir(), "tai-agent-tools-"));
    const path = join(dir, "config.yaml");
    writeFileSync(path, "agents:\n  fine:\n    tools:\n      - read\n      - memory\n");

    const warnings = validateConfig(loadConfig(path));

    expect(warnings.filter((w) => w.includes("agents.fine"))).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });
});
