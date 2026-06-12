import type { AgentConfig } from "./config.js";
import { createHttpRegistryView } from "./http/registry.js";
import {
  createPluginContext,
  type Plugin,
  type PluginConfigValidator,
  type PluginContext,
  type PluginDisposer,
  type PluginMeta,
} from "./plugin-context.js";

export interface LoadedPlugin {
  module: string;
  ok: boolean;
  /**
   * "register" — invoked default(ctx). "side-effect" — relied on top-level
   * imports. "skipped" — entry had `enabled: false`, so it was never imported.
   */
  shape?: "register" | "side-effect" | "skipped";
  error?: string;
  /**
   * Teardown returned by a `register(ctx)` plugin, if any. The host calls
   * this on shutdown / reload to dispose subscriptions, timers, etc.
   * Undefined for side-effect imports, skipped entries, and register plugins
   * that returned nothing.
   */
  stop?: PluginDisposer;
  /** The module's optional `meta` export (#228). */
  meta?: PluginMeta;
  /**
   * Warnings collected from the module's optional `validateConfig` export
   * (#229). The loader also prints them at load time.
   */
  warnings?: string[];
}

export type PluginImporter = (moduleName: string) => Promise<unknown>;

export interface LoadPluginsOptions {
  /**
   * Context handed to `default(ctx)` plugins. Built via
   * {@link createPluginContext} if omitted, which is the right default for
   * the CLI today. Pass a custom one when embedding multiple runtimes (so
   * each gets its own registries — see #47 follow-up).
   */
  context?: PluginContext;
}

/**
 * Dynamic-import every entry in `config.plugins`. Two shapes supported:
 *
 *   - **register(ctx)** — the import exposes a `default` export that's a
 *     function. The loader calls it with a {@link PluginContext}. This is
 *     the recommended shape for new plugins because it doesn't require
 *     the plugin to resolve `@tailored-ai/core` from its install location.
 *   - **side-effect** — the import has no callable default export. Imports
 *     run for their side effects (top-level `registerToolFactory(...)` etc.).
 *     This shape is kept for back-compat but breaks for plugins installed
 *     via `tai plugin install` (#47).
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
 * **Per-entry `config`** in the object form (`{ module, config: { ... } }`)
 * is threaded into `ctx.config` for that plugin's `register(ctx)` — the rest
 * of the context (registries, event bus, runtime) is shared across entries.
 * The default `builtin:*` plugins read their settings from here.
 *
 * **`enabled: false`** on the object form skips the entry entirely: it is not
 * imported and contributes a `shape: "skipped"` result. This is the durable
 * off switch for default plugins, whose module names `migrateDefaultPlugins`
 * re-appends if deleted (see config.ts).
 *
 * **Disposers**: a `register(ctx)` plugin may return a teardown function; it
 * is captured on {@link LoadedPlugin.stop} so the host can dispose it on
 * shutdown / reload.
 */
export async function loadPlugins(
  config: AgentConfig,
  importer: PluginImporter,
  opts: LoadPluginsOptions = {},
): Promise<LoadedPlugin[]> {
  const entries = config.plugins ?? [];
  if (entries.length === 0) return [];

  const baseCtx = opts.context ?? createPluginContext();
  const results: LoadedPlugin[] = [];
  for (const entry of entries) {
    const moduleName = typeof entry === "string" ? entry : entry.module;
    if (!moduleName || typeof moduleName !== "string") {
      console.warn(`[plugins] skipping invalid plugin entry: ${JSON.stringify(entry)}`);
      results.push({ module: String(entry), ok: false, error: "invalid entry shape" });
      continue;
    }
    // Disabled entries are skipped without importing — the durable off
    // switch for default plugins (their module name stays present so the
    // migration won't re-add them, but the loader never runs them).
    if (typeof entry === "object" && entry.enabled === false) {
      console.log(`[plugins] skipping ${moduleName} (enabled: false)`);
      results.push({ module: moduleName, ok: true, shape: "skipped" });
      continue;
    }
    // Per-entry config bag overrides the base context's `config` so each
    // plugin sees only its own settings. Other views (registries, bus,
    // runtime) are shared.
    const entryConfig = typeof entry === "object" && entry.config ? entry.config : {};
    // Namespace this plugin's HTTP routes under `/api/ext/<module>/` so two
    // plugins can't collide. Derived from the runtime's shared registry when
    // present; falls back to the base context's view otherwise (e.g. a
    // partial runtime stub that predates the seam).
    const httpRegistry =
      typeof baseCtx.runtime?.getHttpRoutes === "function" ? baseCtx.runtime.getHttpRoutes() : undefined;
    const http = httpRegistry ? createHttpRegistryView(httpRegistry, moduleName) : baseCtx.http;
    const ctx: PluginContext = { ...baseCtx, config: entryConfig, http };
    try {
      const mod = (await importer(moduleName)) as
        | { default?: unknown; meta?: unknown; validateConfig?: unknown }
        | undefined;
      const register = mod?.default;
      // Optional self-description (#228) — captured as-is when it's an object.
      const meta =
        mod?.meta && typeof mod.meta === "object" && !Array.isArray(mod.meta) ? (mod.meta as PluginMeta) : undefined;
      // Optional plugin-owned config validation (#229). Warnings only — a
      // throwing or misbehaving validator never blocks the load.
      let warnings: string[] | undefined;
      if (typeof mod?.validateConfig === "function") {
        try {
          const returned = (mod.validateConfig as PluginConfigValidator)(config);
          warnings = Array.isArray(returned) ? returned.filter((w) => typeof w === "string") : undefined;
          for (const w of warnings ?? []) {
            console.warn(`[plugins] ${moduleName}: ${w}`);
          }
        } catch (err) {
          console.warn(`[plugins] ${moduleName}: validateConfig threw: ${(err as Error).message} — ignoring`);
        }
      }
      if (typeof register === "function") {
        const disposer = await (register as Plugin)(ctx);
        console.log(`[plugins] loaded ${moduleName} (register)`);
        results.push({
          module: moduleName,
          ok: true,
          shape: "register",
          stop: typeof disposer === "function" ? disposer : undefined,
          meta,
          warnings,
        });
      } else {
        console.log(`[plugins] loaded ${moduleName} (side-effect)`);
        results.push({ module: moduleName, ok: true, shape: "side-effect", meta, warnings });
      }
    } catch (err) {
      const message = (err as Error).message;
      console.warn(`[plugins] failed to load ${moduleName}: ${message} — continuing without it`);
      results.push({ module: moduleName, ok: false, error: message });
    }
  }
  return results;
}
