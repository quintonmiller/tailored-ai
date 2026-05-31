import { describe, expect, it, vi } from "vitest";
import { resolveAgent } from "../agent/agents.js";
import type { AgentConfig } from "../config.js";
import { parseSkillData, type SkillDefinition, SkillRegistry } from "../resources/skill.js";
import type { Tool, ToolContext, ToolResult } from "../tools/interface.js";

function tool(name: string): Tool {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    async execute(_args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      return { success: true, output: name };
    },
  };
}

function baseConfig(): AgentConfig {
  return {
    agent: {
      defaultProvider: "openai_compatible",
      temperature: 0.3,
      maxToolRounds: 10,
      maxHistoryTokens: 2000,
      extraInstructions: "base instructions",
    },
    providers: {
      openai_compatible: { baseUrl: "http://x/v1", defaultModel: "m" },
    },
    agents: {},
    tools: {},
  } as unknown as AgentConfig;
}

describe("parseSkillData", () => {
  it("accepts a fully-populated data block", () => {
    const def = parseSkillData({
      kind: "skill",
      id: "x/y",
      version: "1.0.0",
      data: {
        instructions: "review carefully",
        toolRefs: ["read", "write"],
        knowledgeRefs: ["my/kb"],
        workflowRefs: ["my/wf"],
        promptRefs: { checklist: "my/prompts" },
        hooks: { beforeRun: [{ tool: "memory", args: { action: "read", file: "x.md" } }] },
      },
    });
    expect(def.toolRefs).toEqual(["read", "write"]);
    expect(def.promptRefs?.checklist).toBe("my/prompts");
    expect(def.hooks?.beforeRun).toBeDefined();
  });

  it("rejects malformed fields", () => {
    expect(() => parseSkillData({ kind: "skill", id: "x", version: "1.0.0", data: { toolRefs: [1, 2] } })).toThrow(
      /toolRefs/,
    );
    expect(() => parseSkillData({ kind: "skill", id: "x", version: "1.0.0", data: { instructions: 5 } })).toThrow(
      /instructions/,
    );
  });
});

describe("SkillRegistry", () => {
  it("registers a built-in skill and looks it up", () => {
    const reg = new SkillRegistry();
    reg.registerBuiltin({
      id: "code/review",
      description: "PR review skill",
      definition: { instructions: "Be picky.", toolRefs: ["read"] },
    });
    const skill = reg.get("code/review");
    expect(skill?.instructions).toBe("Be picky.");
    expect(reg.list().length).toBe(1);
  });

  it("rejects mis-kinded resources", () => {
    const reg = new SkillRegistry();
    expect(() =>
      reg.register({
        manifest: { kind: "tool", id: "x", version: "1.0.0" },
        origin: { scheme: "file", uri: "file:///x", loadedAt: 0 },
        body: { manifest: { kind: "skill", id: "x", version: "1.0.0" }, definition: {} },
      }),
    ).toThrow(/expected manifest\.kind="skill"/);
  });
});

describe("resolveAgent + skills", () => {
  it("merges skill instructions, tools, and hooks into the agent", () => {
    const config = baseConfig();
    config.agents.reviewer = {
      instructions: "Agent instructions.",
      tools: ["read"],
      skills: ["code/review"],
      hooks: { beforeRun: { tool: "memory", args: { action: "read", file: "agent.md" } } },
    };
    const all = [tool("read"), tool("write"), tool("memory")];

    const skill: SkillDefinition = {
      instructions: "Skill instructions.",
      toolRefs: ["write"],
      hooks: { afterRun: { tool: "memory", args: { action: "append", file: "log.md" } } },
    };

    const resolved = resolveAgent("reviewer", config, all, undefined, undefined, undefined, {
      resolveSkill: (id) => (id === "code/review" ? skill : undefined),
    });

    expect(resolved.instructions).toBe("Agent instructions.\n\nSkill instructions.");
    expect(resolved.tools.map((t) => t.name)).toEqual(["read", "write"]);
    expect(resolved.hooks.beforeRun.length).toBe(1); // agent's beforeRun
    expect(resolved.hooks.afterRun.length).toBe(1); // skill's afterRun
  });

  it("warns and skips unknown skills without crashing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = baseConfig();
    config.agents.tagged = { instructions: "x", skills: ["ghost/skill"] };
    const resolved = resolveAgent("tagged", config, [tool("read")], undefined, undefined, undefined, {
      resolveSkill: () => undefined,
    });
    expect(resolved.instructions).toBe("x");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`unknown skill "ghost/skill"`));
    warn.mockRestore();
  });

  it("warns and skips skill toolRefs that aren't in allTools", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = baseConfig();
    config.agents.r = { instructions: "x", tools: ["read"], skills: ["s"] };
    const resolved = resolveAgent("r", config, [tool("read")], undefined, undefined, undefined, {
      resolveSkill: () => ({ toolRefs: ["nonexistent"] }),
    });
    expect(resolved.tools.map((t) => t.name)).toEqual(["read"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`unknown tool "nonexistent"`));
    warn.mockRestore();
  });

  it("warns when an agent has skills but no resolveSkill is supplied", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = baseConfig();
    config.agents.silent = { instructions: "x", skills: ["whatever"] };
    resolveAgent("silent", config, [tool("read")]); // no opts
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no resolveSkill callback was supplied"));
    warn.mockRestore();
  });

  it("union-merges tools without duplicates when agent and skill both want one", () => {
    const config = baseConfig();
    config.agents.r = { instructions: "x", tools: ["read"], skills: ["s"] };
    const resolved = resolveAgent("r", config, [tool("read")], undefined, undefined, undefined, {
      resolveSkill: () => ({ toolRefs: ["read"] }),
    });
    expect(resolved.tools.map((t) => t.name)).toEqual(["read"]);
  });
});
