import type { AgentConfig } from "./config.js";
import type { Plugin, PluginContext } from "./plugin-context.js";

export interface LoadedPlugin {
  module: string;
  ok: boolean;
  /** "register" — invoked default(ctx). "side-effect" — relied on top-level imports. */
  shape?: "register" | "side-effect";
  error?: string;
}

export type PluginImporter = (moduleName: string) => Promise<unknown>;

export interface LoadPluginsOptions {
  /**
   * Context handed to `default(ctx)` plugins. The host (CLI / embedder)
   * builds this from its {@link AgentRuntime}'s registries — typically
   * `runtime.pluginContext`. Required: without a ctx there's nothing for
   * plugins to extend.
   */
  context: PluginContext;
}

/**
 * Dynamic-import every entry in `config.plugins`. Two shapes supported:
 *
 *   - **register(ctx)** — the import exposes a `default` export that's a
 *     function. The loader calls it with the supplied {@link PluginContext}.
 *     This is the recommended shape for new plugins because it doesn't
 *     require the plugin to resolve `@tailored-ai/core` from its install
 *     location.
 *   - **side-effect** — the import has no callable default export. Imports
 *     run for their side effects. Kept around for back-compat with the
 *     pre-#47 shape; new plugins should not use it.
 *
 * Call this AFTER constructing AgentRuntime so plugin registrations land in
 * the same Registries bundle the runtime is using.
 *
 * **importer** must be supplied by the caller. Why: dynamic `import(name)`
 * resolves against the *caller's* package, not the user's app. When core is
 * installed as a dep, `node_modules` lookups from inside core can't see the
 * user's other deps. The CLI (or embedder) passes a callback that runs the
 * dynamic import in its own resolution context, typically:
 *
 *     loadPlugins(config, (name) => import(name), { context: runtime.pluginContext })
 *
 * Failures from one plugin do not block the others — each import is wrapped
 * in try/catch, logged, and the next plugin is attempted. The return value
 * lists what loaded and what failed so the caller can surface a summary.
 *
 * Per-plugin `config` values in the declarative entry are reserved for future
 * routing. Today plugins read their configuration from the normal AgentConfig
 * blocks (tools, channels, etc.).
 */
export async function loadPlugins(
  config: AgentConfig,
  importer: PluginImporter,
  opts: LoadPluginsOptions,
): Promise<LoadedPlugin[]> {
  const entries = config.plugins ?? [];
  if (entries.length === 0) return [];

  const ctx = opts.context;
  const results: LoadedPlugin[] = [];
  for (const entry of entries) {
    const moduleName = typeof entry === "string" ? entry : entry.module;
    if (!moduleName || typeof moduleName !== "string") {
      console.warn(`[plugins] skipping invalid plugin entry: ${JSON.stringify(entry)}`);
      results.push({ module: String(entry), ok: false, error: "invalid entry shape" });
      continue;
    }
    try {
      const mod = (await importer(moduleName)) as { default?: unknown } | undefined;
      const register = mod?.default;
      if (typeof register === "function") {
        await (register as Plugin)(ctx);
        console.log(`[plugins] loaded ${moduleName} (register)`);
        results.push({ module: moduleName, ok: true, shape: "register" });
      } else {
        console.log(`[plugins] loaded ${moduleName} (side-effect)`);
        results.push({ module: moduleName, ok: true, shape: "side-effect" });
      }
    } catch (err) {
      const message = (err as Error).message;
      console.warn(`[plugins] failed to load ${moduleName}: ${message} — continuing without it`);
      results.push({ module: moduleName, ok: false, error: message });
    }
  }
  return results;
}
