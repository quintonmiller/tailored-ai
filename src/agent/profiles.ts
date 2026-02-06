import type { AgentConfig, AgentProfile } from '../config.js';
import type { Tool } from '../tools/interface.js';

export interface ResolvedProfile {
  model: string;
  provider: string;
  instructions: string;
  tools: Tool[];
  temperature: number;
  maxToolRounds: number;
}

export function resolveProfile(
  profileName: string | undefined,
  config: AgentConfig,
  allTools: Tool[],
  modelOverride?: string
): ResolvedProfile {
  const providerCfg = config.providers[config.agent.defaultProvider as keyof typeof config.providers];
  const defaultModel = providerCfg && 'defaultModel' in providerCfg ? providerCfg.defaultModel : '';

  const defaults: ResolvedProfile = {
    model: defaultModel,
    provider: config.agent.defaultProvider,
    instructions: config.agent.extraInstructions,
    tools: allTools,
    temperature: config.agent.temperature,
    maxToolRounds: config.agent.maxToolRounds,
  };

  let profile: AgentProfile | undefined;

  if (profileName) {
    profile = config.profiles[profileName];
    if (!profile) {
      throw new Error(`Unknown profile "${profileName}". Available: ${Object.keys(config.profiles).join(', ') || '(none)'}`);
    }
  }

  const resolved: ResolvedProfile = {
    model: modelOverride ?? profile?.model ?? defaults.model,
    provider: profile?.provider ?? defaults.provider,
    instructions: profile?.instructions ?? defaults.instructions,
    tools: defaults.tools,
    temperature: profile?.temperature ?? defaults.temperature,
    maxToolRounds: profile?.maxToolRounds ?? defaults.maxToolRounds,
  };

  if (profile?.tools) {
    const toolMap = new Map(allTools.map((t) => [t.name, t]));
    resolved.tools = profile.tools.map((name) => {
      const tool = toolMap.get(name);
      if (!tool) {
        throw new Error(`Profile "${profileName}" references unknown tool "${name}". Available: ${allTools.map((t) => t.name).join(', ')}`);
      }
      return tool;
    });
  }

  return resolved;
}
