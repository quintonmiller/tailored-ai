import type { AgentConfig } from "./config.js";
import { createHttpRegistryView, type HttpRegistryView } from "./http/registry.js";
import {
  createPluginContext,
  type Plugin,
  type PluginConfigValidator,
  type PluginContext,
  type PluginDisposer,
  type PluginMeta,
} from "./plugin-context.js";
import type { Disposer } from "./registry.js";

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
   * Complete teardown for this plugin: whatever its `register(ctx)` returned,
   * followed by the inverse of every registration it made through `ctx` —
   * tools, channels, providers, backends, commands, HTTP routes — run in
   * reverse order.
   *
   * The plugin's own disposer runs first because it may still need the things
   * it registered; the registrations then come out last-in-first-out, so a
   * later registration never outlives one it was layered on.
   *
   * A plugin therefore gets correct teardown of its registrations without
   * writing an uninstall path, which is the point: before this, cleanup rested
   * on each author remembering, and #58 and #65 are what that produced.
   *
   * Undefined for skipped entries, and for plugins that neither registered
   * anything through `ctx` nor returned a disposer. **Side-effect imports stay
   * undefined**: they register at module scope without a context, so nothing
   * observes what they added and there is nothing to hand back.
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
 * Wrap a context so every registration made through it is also handed to
 * `collect`, and give it this entry's own config bag and route namespace.
 *
 * Each view is re-wrapped by hand rather than mapped generically: there are
 * twelve, the list is closed, and an explicit wrapper is what makes a new view
 * a compile error here instead of a registration that silently escapes
 * collection. Calls delegate through an arrow so a view implemented as a
 * method keeps its receiver.
 */
function collectingContext(
  base: PluginContext,
  http: HttpRegistryView,
  collect: (dispose: Disposer) => void,
  config: Record<string, unknown>,
): PluginContext {
  const wrap =
    <A extends unknown[]>(fn: (...args: A) => Disposer) =>
    (...args: A): Disposer => {
      const dispose = fn(...args);
      collect(dispose);
      return dispose;
    };
  return {
    ...base,
    config,
    tools: { register: wrap((...a) => base.tools.register(...a)) },
    channels: { register: wrap((...a) => base.channels.register(...a)) },
    providers: { register: wrap((...a) => base.providers.register(...a)) },
    embeddings: { register: wrap((...a) => base.embeddings.register(...a)) },
    memoryBackends: { register: wrap((...a) => base.memoryBackends.register(...a)) },
    taskBackends: { register: wrap((...a) => base.taskBackends.register(...a)) },
    repoBackends: { register: wrap((...a) => base.repoBackends.register(...a)) },
    sandboxBackends: { register: wrap((...a) => base.sandboxBackends.register(...a)) },
    uiProviders: { register: wrap((...a) => base.uiProviders.register(...a)) },
    timeProviders: { register: wrap((...a) => base.timeProviders.register(...a)) },
    stepExecutors: { register: wrap((...a) => base.stepExecutors.register(...a)) },
    commands: { register: wrap((...a) => base.commands.register(...a)) },
    http: {
      register: wrap((...a) => http.register(...a)),
      mount: wrap((...a) => http.mount(...a)),
    },
  };
}

/**
 * Build the teardown for one plugin, or `undefined` when there is nothing to
 * tear down.
 *
 * A throwing disposer is logged and the rest still run: teardown that gives up
 * halfway is worse than no teardown, because it leaves a half-removed plugin
 * that nothing will retry.
 */
function composeStop(
  moduleName: string,
  own: PluginDisposer | undefined,
  registered: Disposer[],
): PluginDisposer | undefined {
  if (!own && registered.length === 0) return undefined;
  return async () => {
    if (own) {
      try {
        await own();
      } catch (err) {
        console.warn(`[plugins] ${moduleName}: disposer threw: ${(err as Error).message}`);
      }
    }
    for (let i = registered.length - 1; i >= 0; i--) {
      try {
        registered[i]();
      } catch (err) {
        console.warn(`[plugins] ${moduleName}: unregister threw: ${(err as Error).message}`);
      }
    }
  };
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
 * **Disposers**: a `register(ctx)` plugin may return a teardown function, and
 * every registration it makes through `ctx` yields one of its own. Both are
 * composed onto {@link LoadedPlugin.stop} so the host can undo a plugin as a
 * unit on shutdown / reload.
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
    // Every registration this plugin makes lands here, so unloading it can be
    // the exact inverse of loading it rather than an approximation.
    const registered: Disposer[] = [];
    const ctx = collectingContext(baseCtx, http, (dispose) => registered.push(dispose), entryConfig);
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
          stop: composeStop(moduleName, typeof disposer === "function" ? disposer : undefined, registered),
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
