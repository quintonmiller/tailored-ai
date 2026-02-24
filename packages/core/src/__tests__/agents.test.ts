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
      ollama: { baseUrl: "http://localhost:11434", defaultModel: "test-model" },
    },
    agent: {
      defaultProvider: "ollama",
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
    expect(resolved.provider).toBe("ollama");
    expect(resolved.instructions).toBe("Be helpful.");
    expect(resolved.tools).toEqual(tools);
    expect(resolved.temperature).toBe(0.3);
    expect(resolved.maxToolRounds).toBe(10);
    expect(resolved.contextDir).toBeUndefined();
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
