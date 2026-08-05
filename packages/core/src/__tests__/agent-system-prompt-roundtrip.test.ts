import { describe, expect, it } from "vitest";
import { resolveAgent } from "../agent/agents.js";
import { composeSystemPrompt, resolveBase, resolveCustomLayers } from "../agent/system-prompt.js";
import type { AgentConfig, AgentDefinition } from "../config.js";
import { agentDefinitionToManifest, parseAgentData } from "../resources/agent.js";
import type { ResourceManifest } from "../resources/interface.js";

/**
 * Regression suite: an agent declared in a manifest.yaml (or via the resource
 * registry) with a `systemPrompt:` override must round-trip through
 * parseAgentData -> AgentDefinition -> resolveAgent -> composeSystemPrompt
 * with the override applied.
 *
 * This test catches the failure mode found when wave 12 went live: the
 * AgentDefinition type accepted systemPrompt, but parseAgentData silently
 * dropped it, so manifest-defined agents could not use the feature.
 */
describe("agent systemPrompt round-trip", () => {
  const baseManifest: ResourceManifest = {
    kind: "agent",
    id: "minimal",
    version: "0.0.0",
    data: {
      instructions: "Be terse.",
      systemPrompt: {
        order: ["base", "instructions", "core_memory"],
      },
    },
  };

  it("parseAgentData preserves systemPrompt.order", () => {
    const def = parseAgentData(baseManifest);
    expect(def.systemPrompt?.order).toEqual(["base", "instructions", "core_memory"]);
  });

  it("parseAgentData preserves base + baseFile + custom layers", () => {
    const m: ResourceManifest = {
      ...baseManifest,
      data: {
        systemPrompt: {
          base: "You are X.",
          baseFile: "/tmp/y.md",
          order: ["base", "custom1", "instructions"],
          custom: [{ name: "custom1", content: "hello" }],
        },
      },
    };
    const def = parseAgentData(m);
    expect(def.systemPrompt?.base).toBe("You are X.");
    expect(def.systemPrompt?.baseFile).toBe("/tmp/y.md");
    expect(def.systemPrompt?.order).toEqual(["base", "custom1", "instructions"]);
    expect(def.systemPrompt?.custom).toEqual([{ name: "custom1", content: "hello" }]);
  });

  it("rejects non-object systemPrompt", () => {
    const m: ResourceManifest = {
      ...baseManifest,
      data: { systemPrompt: "not-an-object" },
    };
    expect(() => parseAgentData(m)).toThrow(/`data\.systemPrompt` must be an object/);
  });

  it("agentDefinitionToManifest preserves systemPrompt", () => {
    const def: AgentDefinition = {
      instructions: "x",
      systemPrompt: { order: ["base", "instructions"] },
    };
    const m = agentDefinitionToManifest({ id: "x", definition: def });
    const data = m.data as Record<string, unknown>;
    expect(data.systemPrompt).toEqual({ order: ["base", "instructions"] });
  });

  it("end-to-end: manifest -> parse -> resolveAgent -> composeSystemPrompt strips layers", () => {
    const def = parseAgentData(baseManifest);
    const config: AgentConfig = {
      agent: {
        defaultProvider: "openai",
        extraInstructions: "",
        temperature: 0.3,
        maxToolRounds: 8,
        maxHistoryTokens: 8000,
      },
      providers: { openai: { apiKey: "k", baseUrl: "u", defaultModel: "m" } },
      agents: { minimal: def },
      tools: {},
    } as unknown as AgentConfig;

    const resolved = resolveAgent("minimal", config, []);
    expect(resolved.systemPrompt?.order).toEqual(["base", "instructions", "core_memory"]);

    const composed = composeSystemPrompt(
      resolveBase(resolved.systemPrompt),
      {
        instructions: "[inst]",
        context: "[ctx]",
        skill_catalog: "[cat]",
        core_memory: "[core]",
        chat_live_state: "[live]",
        recall_memory: "[recall]",
      },
      resolved.systemPrompt,
      resolveCustomLayers(resolved.systemPrompt?.custom),
    );

    // Context, catalog, live_state, recall layers are absent because the agent's
    // order omits them. Base comes from the default BASE_SYSTEM_PROMPT.
    expect(composed).toContain("[inst]");
    expect(composed).toContain("[core]");
    expect(composed).not.toContain("[ctx]");
    expect(composed).not.toContain("[cat]");
    expect(composed).not.toContain("[live]");
    expect(composed).not.toContain("[recall]");
  });
});
