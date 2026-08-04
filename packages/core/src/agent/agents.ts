import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import type { AgentConfig, AgentDefinition, AgentHook } from "../config.js";
import type { ThinkingLevel } from "../providers/interface.js";
import type { SkillDefinition } from "../resources/skill.js";
import type { Tool } from "../tools/interface.js";
import { EMPTY_HOOKS, mergeHooks, normalizeHooks, type ResolvedHooks } from "./hooks.js";
import { mergeSystemPromptOverrides, type SystemPromptOverride } from "./system-prompt.js";

/**
 * Entry surfaced in the progressive-mode skill catalog. The agent sees these
 * up-front (name + description) but the full SKILL.md body is only loaded
 * when the agent calls `load_skill(<name>)`.
 */
export interface SkillCatalogEntry {
  id: string;
  description: string;
}

/**
 * Resolve a configured boundary to an absolute path. A leading `~` is expanded
 * because people write it and the check is a string-prefix comparison — an
 * unexpanded tilde would match nothing and silently confine the agent to a
 * directory that does not exist.
 */
function expandBoundary(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const expanded = raw === "~" || raw.startsWith("~/") ? join(homedir(), raw.slice(1)) : raw;
  return resolvePath(expanded);
}

export interface ResolvedAgent {
  model: string;
  provider: string;
  instructions: string;
  tools: Tool[];
  temperature: number;
  /** Per-agent reasoning effort (#254); undefined leaves the provider on its configured default. */
  thinking: ThinkingLevel | undefined;
  /**
   * Cap on generated tokens per call. Undefined omits the field from the
   * request, leaving each provider on its own default.
   */
  maxTokens: number | undefined;
  maxToolRounds: number;
  /** Hard filesystem boundary; undefined means the deployment-wide rules apply. */
  fileBoundary: string | undefined;
  /** Whether room sessions are isolated per room or shared across them. */
  roomSessionScope: "room" | "shared";
  contextDir: string | undefined;
  kbDir: string | undefined;
  nudgeOnText: number;
  nudgeMessage: string;
  skipGlobalContext: boolean;
  summarizeOnTrim: boolean;
  /** True when this agent's task-watcher dispatches run in an isolated worktree. */
  worktree: boolean;
  /** Per-agent task-watcher dispatch preamble template (unexpanded). Empty when unset. */
  taskPreamble: string;
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
  const providerCfg = config.providers[config.agent.defaultProvider];
  const defaultModel = typeof providerCfg?.defaultModel === "string" ? providerCfg.defaultModel : "";

  const defaults: ResolvedAgent = {
    model: defaultModel,
    provider: config.agent.defaultProvider,
    instructions: config.agent.extraInstructions,
    tools: allTools,
    temperature: config.agent.temperature,
    thinking: undefined,
    maxTokens: config.agent.maxTokens,
    maxToolRounds: config.agent.maxToolRounds,
    fileBoundary: undefined,
    roomSessionScope: "room" as const,
    contextDir: undefined,
    kbDir: undefined,
    nudgeOnText: 0,
    nudgeMessage: "",
    skipGlobalContext: false,
    summarizeOnTrim: false,
    worktree: false,
    taskPreamble: "",
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

  // An agent that names its own provider and no model should get THAT
  // provider's default model, not the global provider's. Falling through to
  // `defaults.model` sent one provider's model name to another's endpoint,
  // which surfaces as a confusing 404 for a model that does exist — just not
  // there.
  const agentProviderDefaultModel =
    agent?.provider && agent.provider !== config.agent.defaultProvider
      ? config.providers[agent.provider]?.defaultModel
      : undefined;

  const resolved: ResolvedAgent = {
    model:
      modelOverride ??
      agent?.model ??
      (typeof agentProviderDefaultModel === "string" ? agentProviderDefaultModel : defaults.model),
    provider: agent?.provider ?? defaults.provider,
    instructions: agent?.instructions ?? defaults.instructions,
    tools: defaults.tools,
    temperature: agent?.temperature ?? defaults.temperature,
    thinking: agent?.thinking ?? defaults.thinking,
    maxTokens: agent?.maxTokens ?? defaults.maxTokens,
    maxToolRounds: agent?.maxToolRounds ?? defaults.maxToolRounds,
    fileBoundary: expandBoundary(agent?.fileBoundary),
    roomSessionScope: agent?.roomSessionScope === "shared" ? "shared" : "room",
    contextDir: undefined,
    kbDir: undefined,
    nudgeOnText: agent?.nudgeOnText ?? 0,
    nudgeMessage: agent?.nudgeMessage ?? "",
    skipGlobalContext: agent?.skipGlobalContext ?? false,
    summarizeOnTrim: agent?.summarizeOnTrim ?? false,
    worktree: agent?.worktree ?? false,
    taskPreamble: agent?.taskPreamble ?? "",
    injectMemory: agent?.injectMemory ?? false,
    memoryInjectBudgetTokens: agent?.memoryInjectBudgetTokens,
    memoryInjectLimit: agent?.memoryInjectLimit,
    budgetWarnings: agent?.budgetWarnings ?? false,
    hooks: agent?.hooks ? mergeHooks(agent.hooks) : EMPTY_HOOKS,
    skillLoading: agent?.skillLoading ?? "eager",
    skillCatalog: [],
    systemPrompt: mergeSystemPromptOverrides(config.agent.systemPrompt, agent?.systemPrompt),
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
    const picked: Tool[] = [];
    for (const name of agent.tools) {
      const tool = toolMap.get(name);
      if (tool) {
        picked.push(tool);
        continue;
      }
      // MCP tools (mcp_<server>_<tool>) register after async discovery and
      // disappear when their server is down — skip with a warning instead
      // of failing the whole resolve. The loop re-resolves tools every
      // iteration, so the tool joins as soon as discovery lands.
      if (name.startsWith("mcp_")) {
        warnOnce(
          `mcp:${agentName}:${name}`,
          `[agents] Agent "${agentName}" references MCP tool "${name}" which is not (yet) available`,
        );
        continue;
      }
      // One bad name used to throw, which took the whole agent down.
      //
      // In a room that meant it stopped answering entirely, with the reason
      // only in a log nobody reads — a one-character typo in `tools:` was
      // indistinguishable from an agent that had nothing to say. Skills and
      // MCP refs have always degraded here; this is the same rule applied to
      // the agent's own list. An agent missing one tool can still work and can
      // still be asked what went wrong; an agent that will not resolve cannot.
      warnOnce(
        `tool:${agentName}:${name}`,
        `[agents] Agent "${agentName}" references unknown tool "${name}" — skipping it. Available: ${allTools
          .map((t) => t.name)
          .join(", ")}`,
      );
    }
    resolved.tools = picked;
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

/**
 * Say it once per process.
 *
 * `resolveAgent` runs on every wake, and the agent loop re-resolves tools on
 * every iteration — so a warning here is not a warning, it is a stream. One
 * misconfigured agent would fill the log, and with the error-room plugin
 * running it would fill a channel too.
 */
const _warnedOnce = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (_warnedOnce.has(key)) return;
  _warnedOnce.add(key);
  console.warn(message);
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
