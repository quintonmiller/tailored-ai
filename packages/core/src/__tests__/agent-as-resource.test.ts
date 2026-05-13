import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  AgentRegistry,
  parseAgentData,
  agentDefinitionToManifest,
} from "../resources/agent.js";
import {
  migrateConfigAgentsToResources,
  populateAgentsFromDisk,
  authoredAgentManifestPath,
} from "../resources/agent-migration.js";
import { resolveAgent } from "../agent/agents.js";
import type { AgentConfig, AgentDefinition } from "../config.js";
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

function baseConfig(agents: Record<string, AgentDefinition> = {}): AgentConfig {
  return {
    agent: {
      defaultProvider: "openai_compatible",
      temperature: 0.3,
      maxToolRounds: 10,
      maxHistoryTokens: 2000,
      extraInstructions: "base",
    },
    providers: { openai_compatible: { baseUrl: "http://x/v1", defaultModel: "m" } },
    agents,
    tools: {},
  } as unknown as AgentConfig;
}

describe("agentDefinitionToManifest + parseAgentData round-trip", () => {
  it("preserves all common AgentDefinition fields", () => {
    const def: AgentDefinition = {
      description: "A reviewer",
      instructions: "Be terse.",
      model: "claude-opus-4-7",
      provider: "anthropic",
      tools: ["read", "exec"],
      temperature: 0.5,
      maxToolRounds: 15,
      skills: ["code/review"],
      skillLoading: "progressive",
      sandbox: "docker",
      hooks: { afterRun: { tool: "memory", args: { action: "append" } } },
      summarizeOnTrim: true,
    };
    const manifest = agentDefinitionToManifest({ id: "team/reviewer", definition: def });
    expect(manifest.kind).toBe("agent");
    expect(manifest.id).toBe("team/reviewer");
    expect(manifest.description).toBe("A reviewer");
    const parsed = parseAgentData(manifest);
    expect(parsed.tools).toEqual(["read", "exec"]);
    expect(parsed.skills).toEqual(["code/review"]);
    expect(parsed.skillLoading).toBe("progressive");
    expect(parsed.sandbox).toBe("docker");
    expect(parsed.summarizeOnTrim).toBe(true);
    expect(parsed.hooks).toEqual({ afterRun: { tool: "memory", args: { action: "append" } } });
  });

  it("rejects malformed fields with a clear error", () => {
    expect(() =>
      parseAgentData({ kind: "agent", id: "x", version: "0.0.0", data: { tools: [1, 2] } }),
    ).toThrow(/tools/);
    expect(() =>
      parseAgentData({ kind: "agent", id: "x", version: "0.0.0", data: { sandbox: "spaceship" } }),
    ).toThrow(/sandbox/);
  });
});

describe("AgentRegistry", () => {
  it("registers, looks up, and lists agents", () => {
    const reg = new AgentRegistry();
    reg.registerBuiltin({
      id: "team/reviewer",
      definition: { instructions: "be picky", tools: ["read"] },
    });
    expect(reg.get("team/reviewer")?.tools).toEqual(["read"]);
    expect(reg.list().map((a) => a.id)).toEqual(["team/reviewer"]);
  });

  it("rejects mis-kinded resources", () => {
    const reg = new AgentRegistry();
    expect(() =>
      reg.register({
        manifest: { kind: "tool" as never, id: "x", version: "1.0.0" },
        origin: { scheme: "file", uri: "file:///x", loadedAt: 0 },
        body: { manifest: { kind: "agent", id: "x", version: "1.0.0" }, definition: {} },
      }),
    ).toThrow(/expected manifest\.kind="agent"/);
  });
});

describe("resolveAgent with registry-first lookup", () => {
  it("prefers the registry over config.yaml when both define the same id", () => {
    const config = baseConfig({
      shared: { instructions: "from config", tools: ["read"] },
    });
    const registryDef: AgentDefinition = { instructions: "from registry", tools: ["exec"] };
    const resolved = resolveAgent("shared", config, [tool("read"), tool("exec")], undefined, undefined, undefined, {
      resolveAgentDef: (id) => (id === "shared" ? registryDef : undefined),
    });
    expect(resolved.instructions).toBe("from registry");
    expect(resolved.tools.map((t) => t.name)).toEqual(["exec"]);
  });

  it("falls back to config.yaml with a deprecation log when registry misses", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = baseConfig({
      legacy_agent_test: { instructions: "legacy", tools: ["read"] },
    });
    const resolved = resolveAgent("legacy_agent_test", config, [tool("read")], undefined, undefined, undefined, {
      resolveAgentDef: () => undefined,
    });
    expect(resolved.instructions).toBe("legacy");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("config.yaml"));
    warn.mockRestore();
  });

  it("throws on unknown agent name with a hint about both lookups", () => {
    const config = baseConfig();
    expect(() =>
      resolveAgent("ghost", config, [tool("read")], undefined, undefined, undefined, {
        resolveAgentDef: () => undefined,
      }),
    ).toThrow(/agent registry was consulted/);
  });
});

describe("migrateConfigAgentsToResources", () => {
  let context: string;
  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), "tai-agent-mig-"));
    context = join(tmp, "context");
    mkdirSync(context, { recursive: true });
  });
  afterEach(() => {
    rmSync(context, { recursive: true, force: true });
  });

  it("exports every config.yaml agent to data/authored-resources/agent/<id>/manifest.yaml", () => {
    const config = baseConfig({
      researcher: { instructions: "find things", tools: ["web_search"] },
      reviewer: { instructions: "review code", skills: ["code/review"] },
    });
    const migrated = migrateConfigAgentsToResources(config, context);
    expect(migrated.sort()).toEqual(["researcher", "reviewer"]);
    expect(existsSync(authoredAgentManifestPath(context, "researcher"))).toBe(true);
    const yaml = readFileSync(authoredAgentManifestPath(context, "reviewer"), "utf8");
    const parsed = parseYaml(yaml);
    expect(parsed.kind).toBe("agent");
    expect(parsed.id).toBe("reviewer");
    expect(parsed.data.skills).toEqual(["code/review"]);
  });

  it("is idempotent — does not overwrite existing manifests", () => {
    const config = baseConfig({ keeper: { instructions: "original" } });
    migrateConfigAgentsToResources(config, context);
    writeFileSync(
      authoredAgentManifestPath(context, "keeper"),
      "kind: agent\nid: keeper\nversion: 0.0.0\ndata:\n  instructions: hand-edited\n",
      "utf8",
    );
    const second = migrateConfigAgentsToResources(config, context);
    expect(second).toEqual([]);
    expect(readFileSync(authoredAgentManifestPath(context, "keeper"), "utf8")).toContain("hand-edited");
  });
});

describe("populateAgentsFromDisk", () => {
  let context: string;
  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), "tai-agent-pop-"));
    context = join(tmp, "context");
    mkdirSync(context, { recursive: true });
  });
  afterEach(() => {
    rmSync(context, { recursive: true, force: true });
  });

  it("loads manifests into the registry", () => {
    const config = baseConfig({
      runner: { instructions: "run things", tools: ["exec"] },
    });
    migrateConfigAgentsToResources(config, context);
    const reg = new AgentRegistry();
    const loaded = populateAgentsFromDisk(reg, context);
    expect(loaded).toEqual(["runner"]);
    expect(reg.get("runner")?.tools).toEqual(["exec"]);
  });
});
