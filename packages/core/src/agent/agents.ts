import { join } from "node:path";
import type { AgentConfig, AgentDefinition, AgentHook } from "../config.js";
import type { SkillDefinition } from "../resources/skill.js";
import type { Tool } from "../tools/interface.js";
import { EMPTY_HOOKS, mergeHooks, normalizeHooks, type ResolvedHooks } from "./hooks.js";
import type { SystemPromptOverride } from "./system-prompt.js";

/**
 * Entry surfaced in the progressive-mode skill catalog. The agent sees these
 * up-front (name + description) but the full SKILL.md body is only loaded
 * when the agent calls `load_skill(<name>)`.
 */
export interface SkillCatalogEntry {
  id: string;
  description: string;
}

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
  injectMemory: boolean;
  memoryInjectBudgetTokens: number | undefined;
  memoryInjectLimit: number | undefined;
  budgetWarnings: boolean;
  hooks: ResolvedHooks;
  /**
   * Set to "progressive" when the agent uses agentskills.io-style on-demand
   * loading. "eager" (the legacy default) eager-merges skills at resolve time
   * and leaves `skillCatalog` empty.
   */
  skillLoading: "eager" | "progressive";
  /** Catalog of skills available for `load_skill`. Empty under eager mode. */
  skillCatalog: SkillCatalogEntry[];
  /** System-prompt composition override. Undefined means use defaults. */
  systemPrompt: SystemPromptOverride | undefined;
}

/** @deprecated Use ResolvedAgent instead. */
export type ResolvedProfile = ResolvedAgent;

export interface ResolveAgentOptions {
  /**
   * Look up an agent definition by id. When supplied, the registry takes
   * precedence over `config.agents[name]`. Returning undefined falls through
   * to the config-yaml block (and logs a deprecation if found there).
   * Set by `AgentRuntime.buildLoopOptions` to point at the `AgentRegistry`.
   */
  resolveAgentDef?: (id: string) => AgentDefinition | undefined;
  /**
   * Look up a skill definition by id. When provided, the agent's `skills`
   * list is expanded into the resolved tool set, instructions, and hooks.
   * Returning `undefined` for an id triggers a warning rather than an error,
   * so removed/renamed skills don't crash the agent.
   */
  resolveSkill?: (id: string) => SkillDefinition | undefined;
  /**
   * Look up the discovery metadata (description) for a skill. Used when the
   * agent runs in `progressive` mode to build the skill catalog. Returning
   * `undefined` triggers a warning rather than an error.
   */
  describeSkill?: (id: string) => { description?: string } | undefined;
  /**
   * Enumerate every registered skill id. Used to expand the literal `"*"`
   * entry in an agent's `skills` list (progressive mode only).
   */
  listSkillIds?: () => string[];
}

export function resolveAgent(
  agentName: string | undefined,
  config: AgentConfig,
  allTools: Tool[],
  modelOverride?: string,
  baseContextDir?: string,
  baseKbDir?: string,
  opts?: ResolveAgentOptions,
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
    injectMemory: false,
    memoryInjectBudgetTokens: undefined,
    memoryInjectLimit: undefined,
    budgetWarnings: false,
    hooks: EMPTY_HOOKS,
    skillLoading: "eager",
    skillCatalog: [],
    systemPrompt: undefined,
  };

  let agent: AgentDefinition | undefined;

  if (agentName) {
    // Registry first (S11.4), then fall back to config.yaml for back-compat.
    agent = opts?.resolveAgentDef?.(agentName);
    if (!agent) {
      agent = config.agents[agentName];
      if (agent) {
        maybeWarnConfigAgentDeprecation(agentName);
      }
    }
    if (!agent) {
      throw new Error(
        `Unknown agent "${agentName}". Available (config.yaml): ${Object.keys(config.agents).join(", ") || "(none)"}` +
          (opts?.resolveAgentDef ? " — agent registry was consulted but did not have this id either." : ""),
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
    injectMemory: agent?.injectMemory ?? false,
    memoryInjectBudgetTokens: agent?.memoryInjectBudgetTokens,
    memoryInjectLimit: agent?.memoryInjectLimit,
    budgetWarnings: agent?.budgetWarnings ?? false,
    hooks: agent?.hooks ? mergeHooks(agent.hooks) : EMPTY_HOOKS,
    skillLoading: agent?.skillLoading ?? "eager",
    skillCatalog: [],
    systemPrompt: agent?.systemPrompt,
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

  // Resolve the agent's skills. Two modes:
  //   - eager (default, deprecated): merge skill instructions/tools/hooks into
  //     the resolved agent so the LLM sees them on every turn.
  //   - progressive: build a discovery catalog so the agent can call
  //     `load_skill(name)` on demand. No merging at resolve time.
  if (agent?.skills && agent.skills.length > 0) {
    // Expand the `"*"` wildcard if requested (progressive only — eager would
    // need each skill's definition, which `listSkillIds` doesn't return).
    const declared = agent.skills.includes("*") ? resolveAllSkillIds(agentName, agent.skills, opts) : agent.skills;

    if (resolved.skillLoading === "progressive") {
      const describeSkill = opts?.describeSkill;
      if (!describeSkill) {
        console.warn(
          `[agents] Agent "${agentName}" uses skillLoading: "progressive" but no describeSkill callback was supplied — skill catalog will be empty`,
        );
      } else {
        for (const skillId of declared) {
          const meta = describeSkill(skillId);
          if (!meta) {
            console.warn(`[agents] Agent "${agentName}" references unknown skill "${skillId}"`);
            continue;
          }
          resolved.skillCatalog.push({ id: skillId, description: meta.description ?? "" });
        }
      }
    } else {
      maybeWarnEagerDeprecation(agentName);
      const resolveSkill = opts?.resolveSkill;
      if (!resolveSkill) {
        console.warn(
          `[agents] Agent "${agentName}" declares skills but no resolveSkill callback was supplied — skills ignored`,
        );
      } else {
        const toolMap = new Map(allTools.map((t) => [t.name, t]));
        const haveTool = new Set(resolved.tools.map((t) => t.name));
        const extraBefore: AgentHook[] = [];
        const extraAfter: AgentHook[] = [];

        for (const skillId of declared) {
          const skill = resolveSkill(skillId);
          if (!skill) {
            console.warn(`[agents] Agent "${agentName}" references unknown skill "${skillId}"`);
            continue;
          }
          if (skill.instructions) {
            resolved.instructions = resolved.instructions
              ? `${resolved.instructions}\n\n${skill.instructions}`
              : skill.instructions;
          }
          if (skill.toolRefs) {
            for (const name of skill.toolRefs) {
              if (haveTool.has(name)) continue;
              const tool = toolMap.get(name);
              if (!tool) {
                console.warn(`[agents] Skill "${skillId}" references unknown tool "${name}" — skipping`);
                continue;
              }
              resolved.tools.push(tool);
              haveTool.add(name);
            }
          }
          if (skill.hooks?.beforeRun) extraBefore.push(...normalizeHooks(skill.hooks.beforeRun));
          if (skill.hooks?.afterRun) extraAfter.push(...normalizeHooks(skill.hooks.afterRun));
        }

        if (extraBefore.length > 0 || extraAfter.length > 0) {
          resolved.hooks = mergeHooks(
            { beforeRun: resolved.hooks.beforeRun, afterRun: resolved.hooks.afterRun },
            { beforeRun: extraBefore, afterRun: extraAfter },
          );
        }
      }
    }
  }

  return resolved;
}

function resolveAllSkillIds(
  agentName: string | undefined,
  declared: string[],
  opts: ResolveAgentOptions | undefined,
): string[] {
  const all = opts?.listSkillIds?.();
  if (!all) {
    console.warn(
      `[agents] Agent "${agentName}" requested skills: ["*"] but no listSkillIds callback was supplied — falling back to declared list`,
    );
    return declared.filter((id) => id !== "*");
  }
  const merged = new Set<string>(declared.filter((id) => id !== "*"));
  for (const id of all) merged.add(id);
  return Array.from(merged);
}

const _warnedEagerAgents = new Set<string>();
function maybeWarnEagerDeprecation(agentName: string | undefined): void {
  const key = agentName ?? "(default)";
  if (_warnedEagerAgents.has(key)) return;
  _warnedEagerAgents.add(key);
  console.warn(
    `[agents] DEPRECATION: agent "${key}" uses eager skill merging (the legacy default). ` +
      `Migrate to agentskills.io progressive loading by setting \`skillLoading: progressive\` on the agent.`,
  );
}

const _warnedConfigAgents = new Set<string>();
function maybeWarnConfigAgentDeprecation(agentName: string): void {
  if (_warnedConfigAgents.has(agentName)) return;
  _warnedConfigAgents.add(agentName);
  console.warn(
    `[agents] DEPRECATION: agent "${agentName}" is defined in config.yaml's \`agents:\` block. ` +
      `As of S11.4 agents are first-class resources. The next runtime startup will export it to ` +
      `data/authored-resources/agent/${agentName}/manifest.yaml — after that, remove the config.yaml entry.`,
  );
}

/** @deprecated Use resolveAgent instead. */
export const resolveProfile = resolveAgent;
