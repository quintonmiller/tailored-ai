import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { resolveAgent } from "../agent/agents.js";
import type { AgentConfig } from "../config.js";
import type { Tool } from "../tools/interface.js";

function makeTool(name: string): Tool {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ success: true, output: "" }),
  };
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    server: { port: 3000, host: "0.0.0.0" },
    database: { path: "./agent.db" },
    providers: {
      openai_compatible: { baseUrl: "http://localhost:11434/v1", defaultModel: "test-model" },
    },
    agent: {
      defaultProvider: "openai_compatible",
      extraInstructions: "Be helpful.",
      maxHistoryTokens: 2000,
      temperature: 0.3,
      maxToolRounds: 10,
    },
    channels: {},
    cron: { enabled: false, jobs: [] },
    agents: {},
    context: { directory: "./data/context" },
    tools: {},
    webhooks: { enabled: false, routes: [] },
    custom_tools: {},
    commands: {},
    ...overrides,
  } as AgentConfig;
}

describe("resolveAgent", () => {
  const tools = [makeTool("exec"), makeTool("read"), makeTool("write")];

  it("returns defaults when no agent specified", () => {
    const config = makeConfig();
    const resolved = resolveAgent(undefined, config, tools);

    expect(resolved.model).toBe("test-model");
    expect(resolved.provider).toBe("openai_compatible");
    expect(resolved.instructions).toBe("Be helpful.");
    expect(resolved.tools).toEqual(tools);
    expect(resolved.temperature).toBe(0.3);
    expect(resolved.thinking).toBeUndefined();
    expect(resolved.maxToolRounds).toBe(10);
    expect(resolved.contextDir).toBeUndefined();
  });

  it("resolves per-agent thinking level (#254)", () => {
    const config = makeConfig({
      agents: {
        deep: { thinking: "high" },
      },
    });
    expect(resolveAgent("deep", config, tools).thinking).toBe("high");
    // Agents without an override leave it undefined (provider default applies).
    const plain = makeConfig({ agents: { plain: {} } });
    expect(resolveAgent("plain", plain, tools).thinking).toBeUndefined();
  });

  it("throws for unknown agent", () => {
    const config = makeConfig();
    expect(() => resolveAgent("nonexistent", config, tools)).toThrow("Unknown agent");
  });

  it("overrides model and instructions from agent", () => {
    const config = makeConfig({
      agents: {
        researcher: {
          model: "custom-model",
          instructions: "Research mode.",
          temperature: 0.7,
        },
      },
    });
    const resolved = resolveAgent("researcher", config, tools);

    expect(resolved.model).toBe("custom-model");
    expect(resolved.instructions).toBe("Research mode.");
    expect(resolved.temperature).toBe(0.7);
    // Tools should still be all tools (no tool allowlist in agent)
    expect(resolved.tools).toEqual(tools);
  });

  it("filters tools by agent allowlist", () => {
    const config = makeConfig({
      agents: {
        minimal: {
          tools: ["exec", "read"],
        },
      },
    });
    const resolved = resolveAgent("minimal", config, tools);

    expect(resolved.tools.map((t) => t.name)).toEqual(["exec", "read"]);
  });

  it("throws for unknown tool in agent allowlist", () => {
    const config = makeConfig({
      agents: {
        bad: {
          tools: ["nonexistent_tool"],
        },
      },
    });
    expect(() => resolveAgent("bad", config, tools)).toThrow("unknown tool");
  });

  it("applies model override over agent model", () => {
    const config = makeConfig({
      agents: {
        researcher: { model: "agent-model" },
      },
    });
    const resolved = resolveAgent("researcher", config, tools, "override-model");

    expect(resolved.model).toBe("override-model");
  });

  it("sets contextDir when agent and baseContextDir provided", () => {
    const config = makeConfig({
      agents: {
        researcher: {},
      },
    });
    const resolved = resolveAgent("researcher", config, tools, undefined, "/data/context");

    expect(resolved.contextDir).toContain("agents");
    expect(resolved.contextDir).toContain("researcher");
  });
});

describe("resolveAgent — MCP tool references", () => {
  it("skips a missing mcp_ tool with a warning instead of throwing", () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (msg: string) => warnings.push(msg);
    try {
      const config = makeConfig({
        agents: { helper: { tools: ["test_tool", "mcp_github_search_issues"] } },
      });
      const tools = [makeTool("test_tool")];
      const resolved = resolveAgent("helper", config, tools);
      expect(resolved.tools.map((t) => t.name)).toEqual(["test_tool"]);
      expect(warnings.some((w) => w.includes("mcp_github_search_issues"))).toBe(true);
    } finally {
      console.warn = orig;
    }
  });

  it("includes an mcp_ tool once discovery has registered it", () => {
    const config = makeConfig({
      agents: { helper: { tools: ["mcp_github_search_issues"] } },
    });
    const tools = [makeTool("mcp_github_search_issues")];
    const resolved = resolveAgent("helper", config, tools);
    expect(resolved.tools.map((t) => t.name)).toEqual(["mcp_github_search_issues"]);
  });
});

describe("per-agent file boundary", () => {
  it("resolves a configured boundary to an absolute path", () => {
    const config = makeConfig({
      agents: { planner: { fileBoundary: "/home/quint/research/travel" } },
    });

    expect(resolveAgent("planner", config, [], undefined, "/ctx").fileBoundary).toBe("/home/quint/research/travel");
  });

  it("expands a leading ~, which would otherwise confine the agent to nowhere", () => {
    // The boundary check is a path-prefix comparison, so an unexpanded "~"
    // matches nothing and every write is rejected with a confusing error.
    const config = makeConfig({ agents: { planner: { fileBoundary: "~/research" } } });

    expect(resolveAgent("planner", config, [], undefined, "/ctx").fileBoundary).toBe(`${homedir()}/research`);
  });

  it("is undefined when unset, so deployment-wide rules still apply", () => {
    const config = makeConfig({ agents: { planner: {} } });

    expect(resolveAgent("planner", config, [], undefined, "/ctx").fileBoundary).toBeUndefined();
  });
});
