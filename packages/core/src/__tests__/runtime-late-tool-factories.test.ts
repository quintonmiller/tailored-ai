/**
 * A runtime-context plugin's tools have to actually reach the agent.
 *
 * `createTools()` walks the tool-factory registry exactly once, in the
 * `AgentRuntime` constructor. Every built-in and every registry-pass plugin is
 * in place by then, so that walk sees them all.
 *
 * A **runtime-context plugin** is not. It loads in a second pass, after the
 * runtime exists, because it needs `ctx.runtime` — and `PluginContext` hands it
 * `ctx.tools.register` like everyone else. Before `applyPendingToolFactories`,
 * calling it there returned a disposer, logged nothing, and produced a tool
 * that first appeared on the next reload. A registration that validates and
 * does nothing, which is the failure this repo keeps rediscovering (#561, #609).
 *
 * Nothing shipped had hit it yet: no `builtin:*` plugin registers a tool today.
 * It was found by writing the first one (#616).
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "../config.js";
import { initDatabase } from "../db/schema.js";
import { createTools } from "../factories.js";
import { AgentRuntime } from "../runtime.js";
import type { Tool } from "../tools/interface.js";
import { registerToolFactory } from "../tools/tool-factories.js";

let tmp: string;
let disposers: Array<() => void> = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "tai-late-tools-"));
  disposers = [];
});

afterEach(() => {
  for (const d of disposers) d();
  rmSync(tmp, { recursive: true, force: true });
});

function fakeTool(name: string): Tool {
  return {
    name,
    description: "probe",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ success: true, output: "" }),
  } as unknown as Tool;
}

function buildRuntime() {
  const configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, "server:\n  port: 3000\n");
  const cfg = {
    server: { port: 3000, host: "127.0.0.1" },
    database: { path: ":memory:" },
    agent: {
      defaultProvider: "openai_compatible",
      temperature: 0.3,
      maxToolRounds: 10,
      maxHistoryTokens: 2000,
      extraInstructions: "",
    },
    providers: { openai_compatible: { baseUrl: "http://x/v1", defaultModel: "m" } },
    agents: {},
    tools: {},
    custom_tools: {},
  } as unknown as AgentConfig;

  const db = initDatabase(":memory:");
  const runtime = new AgentRuntime(
    {
      configPath,
      db,
      contextDir: join(tmp, "context"),
      kbDir: join(tmp, "kb"),
      createTools: (c) => createTools(c, join(tmp, "context"), configPath),
      createProvider: () => ({ provider: {} as never, model: "m" }),
    },
    () => cfg,
    cfg,
  );
  return runtime;
}

describe("applyPendingToolFactories", () => {
  it("picks up a factory registered after the runtime was built", () => {
    // The whole point: this is the order a runtime-context plugin runs in.
    const runtime = buildRuntime();
    expect(runtime.getTools().map((t) => t.name)).not.toContain("late_probe");

    disposers.push(registerToolFactory("late_probe", () => [fakeTool("late_probe")]));
    const added = runtime.applyPendingToolFactories();

    expect(added).toContain("late_probe");
    expect(runtime.getTools().map((t) => t.name)).toContain("late_probe");
  });

  it("reports what it added, so a caller can say rather than infer", () => {
    const runtime = buildRuntime();
    disposers.push(registerToolFactory("late_a", () => [fakeTool("late_a")]));
    disposers.push(registerToolFactory("late_b", () => [fakeTool("late_b")]));
    expect(runtime.applyPendingToolFactories().sort()).toEqual(["late_a", "late_b"]);
  });

  it("is idempotent — a second call adds nothing and does not double-register", () => {
    // It runs again on every reload's plugin load, so re-entry is the norm.
    const runtime = buildRuntime();
    disposers.push(registerToolFactory("late_once", () => [fakeTool("late_once")]));
    expect(runtime.applyPendingToolFactories()).toContain("late_once");
    expect(runtime.applyPendingToolFactories()).toEqual([]);
    expect(runtime.getTools().filter((t) => t.name === "late_once")).toHaveLength(1);
  });

  it("leaves tools registered directly in the registry alone", () => {
    // McpManager puts discovered MCP tools straight into the tool registry,
    // not through a factory. Rebuilding the registry would silently drop
    // every one of them, so this is additive rather than a rebuild.
    const runtime = buildRuntime();
    runtime.getToolRegistry().registerBuiltin(fakeTool("mcp_style_direct"));
    runtime.applyPendingToolFactories();
    expect(runtime.getTools().map((t) => t.name)).toContain("mcp_style_direct");
  });

  it("keeps the tools the constructor already built", () => {
    const runtime = buildRuntime();
    const before = runtime
      .getTools()
      .map((t) => t.name)
      .sort();
    disposers.push(registerToolFactory("late_extra", () => [fakeTool("late_extra")]));
    runtime.applyPendingToolFactories();
    const after = runtime.getTools().map((t) => t.name);
    for (const name of before) expect(after).toContain(name);
  });
});
