import type { AgentConfig } from "../config.js";
import { type CreateToolsOptions, createProvider, createTools } from "../factories.js";
import { providerFactoryRegistry } from "../providers/factories.js";
import type { ProviderRegistry } from "./provider-registry.js";
import type { ToolRegistry } from "./tool-registry.js";

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
  // Register every configured provider whose factory is available — built-ins
  // and plugin providers alike, by id. No hardcoded built-in list.
  for (const id of Object.keys(config.providers)) {
    if (!config.providers[id]) continue;
    if (!providerFactoryRegistry.has(id)) continue;
    const { provider, model } = createProvider(applyDefault(config, id));
    registry.registerBuiltin({ id, provider, defaultModel: model });
  }
}

function applyDefault(config: AgentConfig, id: AgentConfig["agent"]["defaultProvider"]): AgentConfig {
  if (config.agent.defaultProvider === id) return config;
  return { ...config, agent: { ...config.agent, defaultProvider: id } };
}
