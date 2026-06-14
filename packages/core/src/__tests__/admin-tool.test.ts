import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { initDatabase } from "../db/schema.js";
import { createTools } from "../factories.js";
import { type AgentConfig, AgentRuntime } from "../index.js";
import type { AIProvider } from "../providers/interface.js";
import { AdminTool, validateCustomTool } from "../tools/admin.js";
import type { ToolContext } from "../tools/interface.js";

function fakeProvider(): AIProvider {
  return {
    id: "fake",
    name: "fake",
    supportsTools: false,
    async chat() {
      return { content: "", usage: { input: 0, output: 0 }, finishReason: "stop" as const };
    },
  };
}

function buildRuntime(initialYaml: string): { runtime: AgentRuntime; configPath: string } {
  const tmp = mkdtempSync(join(tmpdir(), "tai-admin-"));
  const configPath = join(tmp, "config.yaml");
  writeFileSync(configPath, initialYaml, "utf-8");

  const cfg = YAML.parse(initialYaml) as AgentConfig;
  // Fill required defaults the runtime expects.
  cfg.agent ??= {
    defaultProvider: "openai_compatible",
    temperature: 0.3,
    maxToolRounds: 10,
    maxHistoryTokens: 2000,
    extraInstructions: "",
  } as AgentConfig["agent"];
  cfg.providers ??= { openai_compatible: { baseUrl: "http://x/v1", defaultModel: "m" } } as AgentConfig["providers"];
  cfg.agents ??= {};
  cfg.tools ??= {} as AgentConfig["tools"];
  cfg.custom_tools ??= {};

  const db = initDatabase(":memory:");
  const runtime = new AgentRuntime(
    {
      configPath,
      db,
      contextDir: join(tmp, "context"),
      kbDir: join(tmp, "kb"),
      createTools: (c) => createTools(c, join(tmp, "context"), configPath),
      createProvider: () => ({ provider: fakeProvider(), model: "m" }),
    },
    () => {
      // Re-read & rebuild config like the real loader would.
      const raw = readFileSync(configPath, "utf-8");
      const parsed = YAML.parse(raw) as AgentConfig;
      parsed.agent ??= cfg.agent;
      parsed.providers ??= cfg.providers;
      parsed.agents ??= {};
      parsed.tools ??= cfg.tools;
      parsed.custom_tools ??= {};
      return parsed;
    },
    cfg,
  );
  return { runtime, configPath };
}

function ctx(agentName?: string): ToolContext {
  return {
    sessionId: "s1",
    workingDirectory: process.cwd(),
    env: process.env as Record<string, string>,
    agentName,
  };
}

describe("validateCustomTool", () => {
  it("rejects invalid tool names", () => {
    const r = validateCustomTool("3bad", { description: "x", command: "echo", parameters: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Invalid tool name/);
  });

  it("rejects missing description", () => {
    const r = validateCustomTool("ok", { command: "echo", parameters: {} });
    expect(r.ok).toBe(false);
  });

  it("rejects {{tokens}} that have no matching parameter", () => {
    const r = validateCustomTool("ok", {
      description: "d",
      command: "echo {{name}} {{missing}}",
      parameters: { name: { type: "string", description: "n" } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/missing/);
  });

  it("rejects parameters that are declared but never used", () => {
    const r = validateCustomTool("ok", {
      description: "d",
      command: "echo hi",
      parameters: { name: { type: "string", description: "n" } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/never used/);
  });

  it("rejects unsupported parameter types", () => {
    const r = validateCustomTool("ok", {
      description: "d",
      command: "echo {{x}}",
      parameters: { x: { type: "blob", description: "n" } },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/invalid type/);
  });

  it("accepts a well-formed tool and normalizes parameters", () => {
    const r = validateCustomTool("greet", {
      description: "greet someone",
      command: "echo Hello {{name}}",
      parameters: { name: { type: "string", description: "name" } },
      timeout_ms: 1000,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tool.command).toBe("echo Hello {{name}}");
      expect(r.tool.parameters.name.type).toBe("string");
      expect(r.tool.timeout_ms).toBe(1000);
    }
  });
});

describe("AdminTool.create_tool", () => {
  it("writes the tool, reloads, and makes it callable", async () => {
    const { runtime, configPath } = buildRuntime("agents: {}\n");
    const admin = new AdminTool(runtime);

    const result = await admin.execute(
      {
        action: "create_tool",
        name: "greet",
        tool: {
          description: "greet someone",
          command: "echo hi {{name}}",
          parameters: { name: { type: "string", description: "name" } },
        },
      },
      ctx(),
    );

    expect(result.success).toBe(true);
    expect(result.output).toMatch(/Tool "greet" created/);
    expect(result.output).toMatch(/parameters: \{ name: string \}/);

    const written = YAML.parse(readFileSync(configPath, "utf-8")) as { custom_tools: Record<string, unknown> };
    expect(written.custom_tools.greet).toBeDefined();

    const tools = runtime.getTools();
    expect(tools.find((t) => t.name === "greet")).toBeDefined();
  });

  it("auto-appends the new tool to the invoking agent's allowlist", async () => {
    const initial = YAML.stringify({
      agents: { coder: { tools: ["memory"] } },
    });
    const { runtime, configPath } = buildRuntime(initial);
    const admin = new AdminTool(runtime);

    const result = await admin.execute(
      {
        action: "create_tool",
        name: "lint",
        tool: {
          description: "run linter",
          command: "echo lint {{path}}",
          parameters: { path: { type: "string", description: "file path" } },
        },
      },
      ctx("coder"),
    );

    expect(result.success).toBe(true);
    expect(result.output).toMatch(/Added "lint" to agent "coder"/);

    const written = YAML.parse(readFileSync(configPath, "utf-8")) as {
      agents: { coder: { tools: string[] } };
    };
    expect(written.agents.coder.tools).toContain("lint");
    expect(written.agents.coder.tools).toContain("memory");
  });

  it("does not patch the allowlist when the agent has no explicit tools list", async () => {
    const initial = YAML.stringify({ agents: { freeagent: {} } });
    const { runtime, configPath } = buildRuntime(initial);
    const admin = new AdminTool(runtime);

    const result = await admin.execute(
      {
        action: "create_tool",
        name: "ping",
        tool: {
          description: "ping",
          command: "echo {{host}}",
          parameters: { host: { type: "string", description: "h" } },
        },
      },
      ctx("freeagent"),
    );
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/no explicit tools allowlist/);

    const written = YAML.parse(readFileSync(configPath, "utf-8")) as {
      agents: { freeagent: { tools?: string[] } };
    };
    expect(written.agents.freeagent.tools).toBeUndefined();
  });

  it("refuses to create a tool whose name clashes with an existing one", async () => {
    const { runtime } = buildRuntime("agents: {}\n");
    const admin = new AdminTool(runtime);

    // Create once.
    await admin.execute(
      {
        action: "create_tool",
        name: "dupe",
        tool: { description: "d", command: "echo {{x}}", parameters: { x: { type: "string", description: "" } } },
      },
      ctx(),
    );
    // Try again.
    const second = await admin.execute(
      {
        action: "create_tool",
        name: "dupe",
        tool: { description: "d", command: "echo {{x}}", parameters: { x: { type: "string", description: "" } } },
      },
      ctx(),
    );
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/already exists/);
  });

  it("returns a validation error without writing on bad input", async () => {
    const { runtime, configPath } = buildRuntime("agents: {}\n");
    const before = readFileSync(configPath, "utf-8");
    const admin = new AdminTool(runtime);

    const result = await admin.execute(
      {
        action: "create_tool",
        name: "bad",
        tool: { description: "d", command: "echo {{nope}}", parameters: {} },
      },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/nope/);
    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });
});

describe("AdminTool.update_config", () => {
  it("writes a dashboard widget through the allowlisted dashboard. prefix", async () => {
    const { runtime, configPath } = buildRuntime("agents: {}\n");
    const admin = new AdminTool(runtime);

    const widget = {
      id: "today-briefing",
      type: "markdown",
      title: "Today's briefing",
      span: 2,
      options: { endpoint: "/api/briefing", contentField: "content" },
    };
    const result = await admin.execute(
      { action: "update_config", path: "dashboard.widgets", value: [widget] },
      ctx(),
    );

    expect(result.success).toBe(true);
    expect(result.output).toMatch(/Config updated at "dashboard.widgets"/);

    const written = YAML.parse(readFileSync(configPath, "utf-8")) as {
      dashboard: { widgets: Array<{ id: string; type: string }> };
    };
    expect(written.dashboard.widgets[0].id).toBe("today-briefing");
    expect(written.dashboard.widgets[0].type).toBe("markdown");
  });

  it("rejects a path outside the write allowlist", async () => {
    const { runtime, configPath } = buildRuntime("agents: {}\n");
    const before = readFileSync(configPath, "utf-8");
    const admin = new AdminTool(runtime);

    const result = await admin.execute(
      { action: "update_config", path: "server.authToken", value: "leak" },
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not in the allowed set/);
    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });
});
