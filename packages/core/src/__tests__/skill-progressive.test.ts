import { describe, expect, it, vi } from "vitest";
import { resolveAgent } from "../agent/agents.js";
import { createActiveSkillState } from "../agent/active-skill.js";
import { LoadSkillTool } from "../tools/load-skill.js";
import { SkillRegistry, type SkillDefinition } from "../resources/skill.js";
import type { AgentConfig } from "../config.js";
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
      extraInstructions: "base",
    },
    providers: { openai_compatible: { baseUrl: "http://x/v1", defaultModel: "m" } },
    agents: {},
    tools: {},
  } as unknown as AgentConfig;
}

function makeContext(extras: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: "sess-1",
    workingDirectory: process.cwd(),
    env: {},
    ...extras,
  };
}

describe("resolveAgent — progressive skill loading", () => {
  it("populates skillCatalog (not instructions) when skillLoading is progressive", () => {
    const cfg = baseConfig();
    cfg.agents.r = {
      instructions: "agent body",
      skills: ["pdf-processor", "code-reviewer"],
      skillLoading: "progressive",
    };
    const resolved = resolveAgent("r", cfg, [tool("read")], undefined, undefined, undefined, {
      describeSkill: (id) =>
        id === "pdf-processor"
          ? { description: "Extract text from PDFs" }
          : id === "code-reviewer"
            ? { description: "Review code" }
            : undefined,
    });
    expect(resolved.skillLoading).toBe("progressive");
    expect(resolved.skillCatalog).toEqual([
      { id: "pdf-processor", description: "Extract text from PDFs" },
      { id: "code-reviewer", description: "Review code" },
    ]);
    // Skills should NOT have merged into instructions or tools.
    expect(resolved.instructions).toBe("agent body");
    expect(resolved.tools.map((t) => t.name)).toEqual(["read"]);
  });

  it("expands skills: [\"*\"] using listSkillIds in progressive mode", () => {
    const cfg = baseConfig();
    cfg.agents.r = { instructions: "x", skills: ["*"], skillLoading: "progressive" };
    const resolved = resolveAgent("r", cfg, [tool("read")], undefined, undefined, undefined, {
      describeSkill: (id) => ({ description: `desc-${id}` }),
      listSkillIds: () => ["a", "b"],
    });
    expect(resolved.skillCatalog.map((s) => s.id).sort()).toEqual(["a", "b"]);
  });

  it("warns when skillLoading is progressive but no describeSkill is supplied", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cfg = baseConfig();
    cfg.agents.r = { instructions: "x", skills: ["x/y"], skillLoading: "progressive" };
    const resolved = resolveAgent("r", cfg, [tool("read")]);
    expect(resolved.skillCatalog).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no describeSkill callback"));
    warn.mockRestore();
  });

  it("logs a deprecation warning once for agents that still use eager mode", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cfg = baseConfig();
    cfg.agents.legacy_eager_demo = { instructions: "x", skills: ["s"] };
    resolveAgent("legacy_eager_demo", cfg, [tool("read")], undefined, undefined, undefined, {
      resolveSkill: () => ({ instructions: "hi" }),
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("eager skill merging"));
    // Second call to same agent: dedup the deprecation.
    warn.mockClear();
    resolveAgent("legacy_eager_demo", cfg, [tool("read")], undefined, undefined, undefined, {
      resolveSkill: () => ({ instructions: "hi" }),
    });
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("eager skill merging"));
    warn.mockRestore();
  });
});

describe("LoadSkillTool", () => {
  function makeRegistry(): SkillRegistry {
    const reg = new SkillRegistry();
    const def: SkillDefinition = {
      instructions: "Step 1. Open file.\nStep 2. Summarize.",
      toolRefs: ["read"],
    };
    reg.registerBuiltin({ id: "pdf-processor", definition: def, description: "Extract text from PDFs" });
    return reg;
  }

  it("activates a skill, returns its body, and updates activeSkill", async () => {
    const reg = makeRegistry();
    const tool = new LoadSkillTool({ getSkillRegistry: () => reg });
    const activeSkill = createActiveSkillState();
    const ctx = makeContext({ activeSkill });
    const out = await tool.execute({ name: "pdf-processor" }, ctx);
    expect(out.success).toBe(true);
    expect(out.output).toContain("Step 1. Open file.");
    expect(out.output).toContain("skill activated: pdf-processor");
    expect(activeSkill.current?.id).toBe("pdf-processor");
    expect(activeSkill.current?.allowedTools).toEqual(["read"]);
  });

  it("rejects unknown skill names", async () => {
    const reg = makeRegistry();
    const tool = new LoadSkillTool({ getSkillRegistry: () => reg });
    const activeSkill = createActiveSkillState();
    const ctx = makeContext({ activeSkill });
    const out = await tool.execute({ name: "ghost" }, ctx);
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/unknown skill/);
    expect(activeSkill.current).toBeNull();
  });

  it("deactivates the active skill on __deactivate__", async () => {
    const reg = makeRegistry();
    const tool = new LoadSkillTool({ getSkillRegistry: () => reg });
    const activeSkill = createActiveSkillState();
    const ctx = makeContext({ activeSkill });
    await tool.execute({ name: "pdf-processor" }, ctx);
    expect(activeSkill.current).toBeTruthy();
    const out = await tool.execute({ name: "__deactivate__" }, ctx);
    expect(out.success).toBe(true);
    expect(activeSkill.current).toBeNull();
  });

  it("errors cleanly when the loop forgot to provide activeSkill state", async () => {
    const reg = makeRegistry();
    const tool = new LoadSkillTool({ getSkillRegistry: () => reg });
    const ctx = makeContext();
    const out = await tool.execute({ name: "pdf-processor" }, ctx);
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/no activeSkill state/);
  });
});
