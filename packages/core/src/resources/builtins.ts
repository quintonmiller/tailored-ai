import type { AgentConfig } from "../config.js";
import { createTools, createProvider, type CreateToolsOptions } from "../factories.js";
import { ToolRegistry } from "./tool-registry.js";
import { ProviderRegistry } from "./provider-registry.js";

export interface PopulateRegistriesOptions extends CreateToolsOptions {
  config: AgentConfig;
  contextDir: string;
  configPath?: string;
}

/**
 * Walks the existing `createTools` / `createProvider` factories and
 * registers each output as a built-in resource in the supplied registries.
 *
 * This is the bridge between the old factory-based wiring and the new
 * registry-based one: while subsystems are being migrated, both surfaces
 * stay in sync. Once all consumers read through the registry, the
 * factories can be retired in favor of resource-driven loading.
 */
export function populateBuiltinTools(registry: ToolRegistry, opts: PopulateRegistriesOptions): void {
  const tools = createTools(opts.config, opts.contextDir, opts.configPath, {
    db: opts.db,
    getDiscord: opts.getDiscord,
    getOwnerId: opts.getOwnerId,
    taskBackend: opts.taskBackend,
  });
  for (const tool of tools) {
    registry.registerBuiltin(tool);
  }
}

/**
 * Registers every provider that has config in `config.providers` as a built-in,
 * not just the one selected by `agent.defaultProvider`. This lets callers
 * switch providers at runtime by id without rebuilding.
 */
export function populateBuiltinProviders(registry: ProviderRegistry, config: AgentConfig): void {
  const providers = config.providers;
  if (providers.openai_compatible) {
    const tmp = applyDefault(config, "openai_compatible");
    const { provider, model } = createProvider(tmp);
    registry.registerBuiltin({ id: "openai_compatible", provider, defaultModel: model });
  }
  if (providers.openai) {
    const tmp = applyDefault(config, "openai");
    const { provider, model } = createProvider(tmp);
    registry.registerBuiltin({ id: "openai", provider, defaultModel: model });
  }
  if (providers.anthropic) {
    const tmp = applyDefault(config, "anthropic");
    const { provider, model } = createProvider(tmp);
    registry.registerBuiltin({ id: "anthropic", provider, defaultModel: model });
  }
}

function applyDefault(config: AgentConfig, id: AgentConfig["agent"]["defaultProvider"]): AgentConfig {
  if (config.agent.defaultProvider === id) return config;
  return { ...config, agent: { ...config.agent, defaultProvider: id } };
}
