/**
 * Tool-factory registry tests — built-ins construct through the registry
 * exactly like plugin tools, and createTools() is a pure registry walk
 * (no if-chain). This file is the regression guard for issue #203.
 *
 * NOTE: This file tests the registry, builtin.ts registration, and
 * validateConfig meta-tool resolution. It deliberately avoids importing
 * factories.ts (which would pull in builtin-optional.ts → browser-mediator,
 * a workspace dep not built in test mode). The createTools integration is
 * covered by admin-tool.test.ts and workflow tests in the full test suite.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../config.js";
import { validateConfig } from "../config.js";
import type { Tool } from "../tools/interface.js";
import {
  META_TOOL_NAMES,
  registerToolFactory,
  runToolFactories,
  toolFactoryRegistry,
} from "../tools/tool-factories.js";
// Side-effect: registers all built-in factories (memory, exec, read, write,
// web_fetch, web_search, facts, recall, tasks, notify_owner, claude_code,
// browser, md_to_pdf, projects, documents, extract_document, ask_user,
// custom_tools).
import "../tools/builtin.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal config — matches the shape validateConfig uses. */
function baseConfig(toolOverrides: Record<string, unknown> = {}): AgentConfig {
  return {
    server: { port: 3000, host: "127.0.0.1" },
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
    context: { directory: "/tmp/ctx", kbDirectory: "/tmp/kb" },
    channels: {},
    tools: toolOverrides as AgentConfig["tools"],
    taskWatcher: { enabled: false, prompt: "", debounceMs: 5000, triggers: [] },
    webhooks: { enabled: false, routes: [] },
    custom_tools: {},
    commands: {},
  };
}

/** Extract tool names from a Tool[] (normalises the assertion surface). */
function toolNames(tools: Tool[]): string[] {
  return tools.map((t) => t.name).sort();
}

// ---------------------------------------------------------------------------
// runToolFactories — registry-based construction
// ---------------------------------------------------------------------------

describe("runToolFactories — built-in tools via registry", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("produces memory, exec, read, write, web_fetch for a minimal config with contextDir", () => {
    const tools = runToolFactories(baseConfig(), { contextDir: "/tmp/ctx" });
    const n = toolNames(tools);
    expect(n).toContain("memory");
    expect(n).toContain("exec");
    expect(n).toContain("read");
    expect(n).toContain("write");
    expect(n).toContain("web_fetch");
  });

  it("omits ask_user when contextDir is absent", () => {
    // ask_user factory returns [] when ctx.contextDir is falsy
    const tools = runToolFactories(baseConfig(), {});
    expect(toolNames(tools)).not.toContain("ask_user");
  });

  it("includes ask_user when contextDir is provided", () => {
    const tools = runToolFactories(baseConfig(), { contextDir: "/tmp/ctx" });
    expect(toolNames(tools)).toContain("ask_user");
  });

  it("respects enabled: false for default-on tools", () => {
    const cfg = baseConfig({
      memory: { enabled: false },
      exec: { enabled: false },
      read: { enabled: false },
      write: { enabled: false },
      web_fetch: { enabled: false },
      ask_user: { enabled: false },
    });
    const n = toolNames(runToolFactories(cfg, { contextDir: "/tmp/ctx" }));
    expect(n).not.toContain("memory");
    expect(n).not.toContain("exec");
    expect(n).not.toContain("read");
    expect(n).not.toContain("write");
    expect(n).not.toContain("web_fetch");
    expect(n).not.toContain("ask_user");
  });

  it("enables web_search only when apiKey is present", () => {
    // No apiKey: tool should be omitted
    const noKey = baseConfig({ web_search: { enabled: true } });
    expect(toolNames(runToolFactories(noKey, {}))).not.toContain("web_search");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("apiKey is empty"));

    warnSpy.mockClear();

    // With apiKey: tool should appear
    const withKey = baseConfig({ web_search: { enabled: true, apiKey: "test-key" } });
    expect(toolNames(runToolFactories(withKey, {}))).toContain("web_search");
  });

  it("does not include facts, recall, tasks, projects, documents without a db", () => {
    const n = toolNames(runToolFactories(baseConfig(), { contextDir: "/tmp/ctx" }));
    expect(n).not.toContain("facts");
    expect(n).not.toContain("recall");
    expect(n).not.toContain("tasks");
    expect(n).not.toContain("task_query");
    expect(n).not.toContain("projects");
    expect(n).not.toContain("documents");
  });

  it("includes notify_owner when resolveOutbound is wired", () => {
    const cfg = baseConfig({ notify_owner: { enabled: true } });
    const tools = runToolFactories(cfg, {
      contextDir: "/tmp/ctx",
      resolveOutbound: () => undefined,
    });
    expect(toolNames(tools)).toContain("notify_owner");
  });

  it("omits notify_owner when resolveOutbound is absent", () => {
    const cfg = baseConfig({ notify_owner: { enabled: true } });
    const tools = runToolFactories(cfg, { contextDir: "/tmp/ctx" });
    expect(toolNames(tools)).not.toContain("notify_owner");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("outbound accessor"));
  });

  it("includes claude_code when enabled", () => {
    const cfg = baseConfig({ claude_code: { enabled: true, maxTurns: 5 } });
    expect(toolNames(runToolFactories(cfg, {}))).toContain("claude_code");
  });

  it("includes md_to_pdf when enabled", () => {
    const cfg = baseConfig({ md_to_pdf: { enabled: true } });
    expect(toolNames(runToolFactories(cfg, {}))).toContain("md_to_pdf");
  });

  it("includes custom tools from custom_tools config", () => {
    const cfg = baseConfig();
    cfg.custom_tools = { my_tool: { command: "echo hi", description: "A test tool" } };
    expect(toolNames(runToolFactories(cfg, {}))).toContain("my_tool");
  });
});

// ---------------------------------------------------------------------------
// Third-party / plugin factory
// ---------------------------------------------------------------------------

describe("runToolFactories — third-party factory registration", () => {
  const TEST_ID = "__test_plugin_tool__";

  afterEach(() => {
    toolFactoryRegistry.unregister(TEST_ID);
  });

  it("shows up in runToolFactories output when registered at runtime", () => {
    const fakeTool: Tool = {
      name: TEST_ID,
      description: "test",
      parameters: {},
      execute: async () => ({ success: true, output: "" }),
    };

    registerToolFactory(TEST_ID, () => [fakeTool]);

    const tools = runToolFactories(baseConfig(), { contextDir: "/tmp/ctx" });
    expect(toolNames(tools)).toContain(TEST_ID);
  });

  it("is skipped (with warn) when factory throws", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerToolFactory(TEST_ID, () => {
      throw new Error("boom");
    });

    expect(() => runToolFactories(baseConfig(), {})).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(TEST_ID));
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// META_TOOL_NAMES — exported constant keeps validateConfig in sync
// ---------------------------------------------------------------------------

describe("META_TOOL_NAMES", () => {
  it("includes the canonical meta-tool names", () => {
    expect(META_TOOL_NAMES).toContain("delegate");
    expect(META_TOOL_NAMES).toContain("task_status");
    expect(META_TOOL_NAMES).toContain("admin");
    expect(META_TOOL_NAMES).toContain("memory");
    expect(META_TOOL_NAMES).toContain("ask_user");
  });
});

// ---------------------------------------------------------------------------
// validateConfig — meta-tool refs no longer flag unknown-tool warnings
// ---------------------------------------------------------------------------

describe("validateConfig — meta-tool references", () => {
  it("does not warn when an agent tool list includes meta-tool names", () => {
    const c = baseConfig();
    c.agents = {
      myAgent: {
        tools: ["memory", "delegate", "task_status", "admin", "ask_user"],
      },
    };
    const warnings = validateConfig(c);
    const toolWarnings = warnings.filter((w) => w.includes("myAgent") && w.includes("not enabled"));
    expect(toolWarnings).toHaveLength(0);
  });

  it("flags a reference to a tool that is neither enabled nor meta", () => {
    const c = baseConfig();
    c.agents = { myAgent: { tools: ["phantom_tool"] } };
    const warnings = validateConfig(c);
    expect(warnings.some((w) => w.includes("phantom_tool") && w.includes("not enabled"))).toBe(true);
  });

  it("does not flag built-in tool names that are enabled-by-default", () => {
    const c = baseConfig({
      memory: { enabled: true },
      exec: { enabled: true },
      read: { enabled: true },
    });
    c.agents = { myAgent: { tools: ["memory", "exec", "read"] } };
    const warnings = validateConfig(c);
    expect(warnings.filter((w) => w.includes("not enabled"))).toHaveLength(0);
  });
});
