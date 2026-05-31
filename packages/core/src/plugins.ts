import type { AgentConfig } from "./config.js";

export interface LoadedPlugin {
  module: string;
  ok: boolean;
  error?: string;
}

export type PluginImporter = (moduleName: string) => Promise<unknown>;

/**
 * Dynamic-import every entry in `config.plugins`. Each module's import
 * side-effects are expected to register tools / channels / providers / task
 * backends / step executors / triggers into the matching registries on
 * `@tailored-ai/core`.
 *
 * Call this before constructing AgentRuntime so the registries are populated
 * before the runtime asks them anything.
 *
 * **importer** must be supplied by the caller. Why: dynamic `import(name)`
 * resolves against the *caller's* package, not the user's app. When core is
 * installed as a dep, `node_modules` lookups from inside core can't see the
 * user's other deps. The CLI (or embedder) passes a callback that runs the
 * dynamic import in its own resolution context, typically:
 *
 *     loadPlugins(config, (name) => import(name))
 *
 * Failures from one plugin do not block the others — each import is wrapped
 * in try/catch, logged, and the next plugin is attempted. The return value
 * lists what loaded and what failed so the caller can surface a summary.
 *
 * Per-plugin `config` values in the declarative entry are reserved for future
 * routing. Today plugins read their configuration from the normal AgentConfig
 * blocks (tools, channels, etc.).
 */
export async function loadPlugins(config: AgentConfig, importer: PluginImporter): Promise<LoadedPlugin[]> {
  const entries = config.plugins ?? [];
  if (entries.length === 0) return [];

  const results: LoadedPlugin[] = [];
  for (const entry of entries) {
    const moduleName = typeof entry === "string" ? entry : entry.module;
    if (!moduleName || typeof moduleName !== "string") {
      console.warn(`[plugins] skipping invalid plugin entry: ${JSON.stringify(entry)}`);
      results.push({ module: String(entry), ok: false, error: "invalid entry shape" });
      continue;
    }
    try {
      await importer(moduleName);
      console.log(`[plugins] loaded ${moduleName}`);
      results.push({ module: moduleName, ok: true });
    } catch (err) {
      const message = (err as Error).message;
      console.warn(`[plugins] failed to load ${moduleName}: ${message} — continuing without it`);
      results.push({ module: moduleName, ok: false, error: message });
    }
  }
  return results;
}
