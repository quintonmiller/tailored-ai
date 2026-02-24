import { join } from "node:path";
import type { AgentConfig, AgentDefinition } from "../config.js";
import type { Tool } from "../tools/interface.js";
import { EMPTY_HOOKS, mergeHooks, type ResolvedHooks } from "./hooks.js";

export interface ResolvedAgent {
  model: string;
  provider: string;
  instructions: string;
  tools: Tool[];
  temperature: number;
  maxToolRounds: number;
  contextDir: string | undefined;
  kbDir: string | undefined;
  nudgeOnText: number;
  nudgeMessage: string;
  skipGlobalContext: boolean;
  summarizeOnTrim: boolean;
  hooks: ResolvedHooks;
}

/** @deprecated Use ResolvedAgent instead. */
export type ResolvedProfile = ResolvedAgent;

export function resolveAgent(
  agentName: string | undefined,
  config: AgentConfig,
  allTools: Tool[],
  modelOverride?: string,
  baseContextDir?: string,
  baseKbDir?: string,
): ResolvedAgent {
  const providerCfg = config.providers[config.agent.defaultProvider as keyof typeof config.providers];
  const defaultModel = providerCfg && "defaultModel" in providerCfg ? providerCfg.defaultModel : "";

  const defaults: ResolvedAgent = {
    model: defaultModel,
    provider: config.agent.defaultProvider,
    instructions: config.agent.extraInstructions,
    tools: allTools,
    temperature: config.agent.temperature,
    maxToolRounds: config.agent.maxToolRounds,
    contextDir: undefined,
    kbDir: undefined,
    nudgeOnText: 0,
    nudgeMessage: "",
    skipGlobalContext: false,
    summarizeOnTrim: false,
    hooks: EMPTY_HOOKS,
  };

  let agent: AgentDefinition | undefined;

  if (agentName) {
    agent = config.agents[agentName];
    if (!agent) {
      throw new Error(
        `Unknown agent "${agentName}". Available: ${Object.keys(config.agents).join(", ") || "(none)"}`,
      );
    }
  }

  const resolved: ResolvedAgent = {
    model: modelOverride ?? agent?.model ?? defaults.model,
    provider: agent?.provider ?? defaults.provider,
    instructions: agent?.instructions ?? defaults.instructions,
    tools: defaults.tools,
    temperature: agent?.temperature ?? defaults.temperature,
    maxToolRounds: agent?.maxToolRounds ?? defaults.maxToolRounds,
    contextDir: undefined,
    kbDir: undefined,
    nudgeOnText: agent?.nudgeOnText ?? 0,
    nudgeMessage: agent?.nudgeMessage ?? "",
    skipGlobalContext: agent?.skipGlobalContext ?? false,
    summarizeOnTrim: agent?.summarizeOnTrim ?? false,
    hooks: agent?.hooks ? mergeHooks(agent.hooks) : EMPTY_HOOKS,
  };

  // Derive contextDir when an agent is active
  if (agentName && baseContextDir) {
    resolved.contextDir = agent?.contextDir ?? join(baseContextDir, "agents", agentName);
  }

  // Derive agent-specific kbDir when an agent is active
  if (agentName && baseKbDir) {
    resolved.kbDir = join(baseKbDir, "agents", agentName);
  }

  if (agent?.tools) {
    const toolMap = new Map(allTools.map((t) => [t.name, t]));
    resolved.tools = agent.tools.map((name) => {
      const tool = toolMap.get(name);
      if (!tool) {
        throw new Error(
          `Agent "${agentName}" references unknown tool "${name}". Available: ${allTools.map((t) => t.name).join(", ")}`,
        );
      }
      return tool;
    });
  }

  return resolved;
}

/** @deprecated Use resolveAgent instead. */
export const resolveProfile = resolveAgent;
