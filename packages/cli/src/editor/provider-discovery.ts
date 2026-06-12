/**
 * Provider discovery for the editor (#225). Two sources:
 *
 *   1. **Built-ins** — core registers them into `providerFactoryRegistry`
 *      on module load, so importing core is enough.
 *   2. **Plugin providers** — the config's `plugins:` entries run against a
 *      *capture* PluginContext whose `providers.register` records ids and
 *      factories without touching the global registries. The editor learns
 *      what each plugin would register without committing the process to it.
 *
 * Model discovery piggybacks on the optional `AIProvider.listModels`
 * capability (#226): build the provider through its captured factory and
 * ask it. Duck-typed so this compiles against any core version; providers
 * without the capability simply yield no list and the editor falls back to
 * free-text model entry.
 */
import {
  type AgentConfig,
  loadPlugins,
  type PluginContext,
  type ProviderFactory,
  providerFactoryRegistry,
  TypedEventBus,
} from "@tailored-ai/core";
import { PluginManager } from "../plugins/manager.js";

export interface DiscoveredProvider {
  id: string;
  source: "builtin" | "plugin";
  factory: ProviderFactory;
}

/** PluginContext whose only live namespace is a providers capture. */
function captureContext(onProvider: (id: string, factory: ProviderFactory) => void): PluginContext {
  const noop = { register: () => {} };
  return {
    tools: noop,
    channels: noop,
    providers: { register: onProvider },
    embeddings: noop,
    memoryBackends: noop,
    taskBackends: noop,
    repoBackends: noop,
    sandboxBackends: noop,
    uiProviders: noop,
    stepExecutors: noop,
    http: { register: () => {} },
    events: new TypedEventBus(),
    config: {},
  } as unknown as PluginContext;
}

/** Run `fn` with console.log/warn silenced — loader chatter would scribble over the TUI. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  const warn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

/**
 * Discover every provider id selectable in the editor. `config` supplies
 * the `plugins:` entries to probe (omit for a fresh install — built-ins
 * only). Plugin load failures are swallowed per entry, same policy as the
 * real loader: a broken plugin shouldn't take the editor down.
 */
export async function discoverProviders(homeDir: string, config?: AgentConfig): Promise<DiscoveredProvider[]> {
  const found = new Map<string, DiscoveredProvider>();
  for (const id of providerFactoryRegistry.list()) {
    const factory = providerFactoryRegistry.get(id);
    if (factory) found.set(id, { id, source: "builtin", factory });
  }

  const entries = (config?.plugins ?? []).filter((e) => {
    const m = typeof e === "string" ? e : e.module;
    // builtin:* plugins are event subscribers needing ctx.runtime — they
    // can't register providers, so skip the imports.
    return typeof m === "string" && !m.startsWith("builtin:");
  });
  if (config && entries.length > 0) {
    const importer = new PluginManager(homeDir).buildImporter();
    const ctx = captureContext((id, factory) => {
      if (!found.has(id)) found.set(id, { id, source: "plugin", factory });
    });
    await quietly(() => loadPlugins({ ...config, plugins: entries }, importer, { context: ctx }));
  }

  return [...found.values()];
}

/**
 * Ask a discovered provider for its model catalog via the optional
 * `listModels` capability. Returns undefined when the provider doesn't
 * implement it or when construction/listing fails (missing config, server
 * down) — the editor then falls back to free-text entry.
 */
export async function listModelsFor(
  discovered: DiscoveredProvider,
  config: AgentConfig,
  timeoutMs = 5000,
): Promise<string[] | undefined> {
  try {
    const { provider } = discovered.factory(config);
    const listModels = (provider as { listModels?: () => Promise<string[]> }).listModels;
    if (typeof listModels !== "function") return undefined;
    const models = await Promise.race([
      listModels.call(provider),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("listModels timed out")), timeoutMs)),
    ]);
    return Array.isArray(models) && models.length > 0 ? models : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the config a provider factory probes against: the on-disk config
 * (env-interpolated) when editing an existing install, overlaid with the
 * editor draft's fields for the selected kind so unsaved baseUrl/apiKey
 * edits take effect. Falls back to a minimal config for fresh installs.
 */
export function buildProbeConfig(
  kind: string,
  draft: { baseUrl?: string; apiKey?: string; defaultModel?: string },
  baseConfig?: AgentConfig,
): AgentConfig {
  const base = baseConfig ?? ({ providers: {}, agent: { defaultProvider: kind } } as unknown as AgentConfig);
  const existing = (base.providers?.[kind] as Record<string, unknown> | undefined) ?? {};
  return {
    ...base,
    providers: {
      ...base.providers,
      [kind]: {
        ...existing,
        ...(draft.baseUrl ? { baseUrl: draft.baseUrl } : {}),
        ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
        // requireModel-style factories insist on a defaultModel even though
        // listModels doesn't need one — placeholder keeps construction alive.
        defaultModel: draft.defaultModel || (existing.defaultModel as string | undefined) || "model-discovery",
      },
    },
  };
}
