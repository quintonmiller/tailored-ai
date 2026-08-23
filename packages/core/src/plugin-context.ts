/**
 * Plugin contract — the runtime hands the plugin a {@link PluginContext} and
 * the plugin uses it to extend behavior. Compare with the legacy side-effect
 * shape (modules that import core and call `registerToolFactory(...)` at
 * load time): that shape requires the plugin to resolve `@tailored-ai/core`
 * from its install location, which breaks when a plugin is installed via
 * `tai plugin install` outside the host's resolution tree (#47).
 *
 * The ctx shape is intentionally type-only friendly. A plugin only needs:
 *
 *     import type { Plugin } from "@tailored-ai/core";
 *     export default ((ctx) => {
 *       ctx.tools.register("echo", () => [echoTool]);
 *     }) satisfies Plugin;
 *
 * The `import type` is erased at compile time, so the plugin has *zero*
 * runtime dependency on core. Installation, resolution, and instance
 * identity stop being a problem.
 *
 * Today this is a thin wrapper around the existing module-scope register*
 * functions — see {@link createPluginContext}. The follow-up work in #47
 * moves the registries themselves onto the runtime so multiple runtimes in
 * one process stop sharing state.
 */

import type { ChannelFactory } from "./channels/registry.js";
import { registerChannelFactory } from "./channels/registry.js";
import type { SlashCommandDescriptor, SlashCommandRegistryView } from "./commands/registry.js";
import { slashCommandRegistry } from "./commands/registry.js";
import { type EventBus, TypedEventBus } from "./events.js";
import { createHttpRegistryView, type HttpRegistryView, HttpRouteRegistry } from "./http/registry.js";
import type { MemoryBackendFactory } from "./memory/registry.js";
import { registerMemoryBackendFactory } from "./memory/registry.js";
import type { EmbeddingFactory, ProviderFactory } from "./providers/factories.js";
import { registerEmbeddingFactory, registerProviderFactory } from "./providers/factories.js";
import type { Disposer } from "./registry.js";
import type { RepoBackendFactory } from "./repo/factory.js";
import { registerRepoBackendFactory } from "./repo/factory.js";
import type { StepExecutorFactory } from "./resources/step-executor-registry.js";
import type { AgentRuntime } from "./runtime.js";
import type { SandboxFactory } from "./sandboxes/factory.js";
import { registerSandboxFactory } from "./sandboxes/factory.js";
import type { TaskBackendFactory } from "./tasks/factory.js";
import { registerTaskBackendFactory } from "./tasks/factory.js";
import type { TimeProviderFactory } from "./time/provider.js";
import { registerTimeProviderFactory } from "./time/provider.js";
import type { ToolFactory } from "./tools/tool-factories.js";
import { registerToolFactory } from "./tools/tool-factories.js";
import type { UiProviderFactory } from "./ui/registry.js";
import { registerUiProviderFactory } from "./ui/registry.js";

/**
 * Every registry view hands back a {@link Disposer} — the inverse of the
 * registration it just made.
 *
 * Ignoring it keeps the old behaviour, so this is source-compatible with every
 * plugin written before the contract existed. Returning it is what makes
 * teardown possible at all: without a per-registration inverse there is no
 * unit to revert, and unloading a plugin can only be approximated by throwing
 * away shared state — which is what `reload()` does today, and why #58 and #65
 * happened. The loader collects these automatically (see
 * {@link CreatePluginContextOptions.collect}), so a plugin gets correct
 * teardown of its registrations without writing an uninstall path.
 */
export interface ToolRegistryView {
  register(id: string, factory: ToolFactory): Disposer;
}

export interface ChannelRegistryView {
  register(id: string, factory: ChannelFactory): Disposer;
}

export interface ProviderRegistryView {
  register(id: string, factory: ProviderFactory): Disposer;
}

export interface EmbeddingRegistryView {
  register(id: string, factory: EmbeddingFactory): Disposer;
}

export interface MemoryBackendRegistryView {
  register(id: string, factory: MemoryBackendFactory): Disposer;
}

export interface TaskBackendRegistryView {
  register(id: string, factory: TaskBackendFactory): Disposer;
}

export interface RepoBackendRegistryView {
  register(id: string, factory: RepoBackendFactory): Disposer;
}

export interface SandboxBackendRegistryView {
  register(id: string, factory: SandboxFactory): Disposer;
}

export interface UiProviderRegistryView {
  register(id: string, factory: UiProviderFactory): Disposer;
}

export interface TimeProviderRegistryView {
  register(id: string, factory: TimeProviderFactory): Disposer;
}

/**
 * Plugin view of the step-executor registry. Plugins call
 * `ctx.stepExecutors.register(type, factory)` to inject a custom executor.
 * The factory is called by `createWorkflowEngine` with the same context
 * built-ins receive, so plugins get first-class parity with built-ins.
 *
 * `type` must match the `step.type` string in workflow YAML. Registering for
 * an existing type overrides the built-in; the last-registered factory wins.
 */
export interface StepExecutorRegistryView {
  register(type: string, factory: StepExecutorFactory): Disposer;
}

/**
 * Surface a plugin uses to extend the runtime. Each namespace is a thin
 * registry view — plugins only see `register`, not the internal storage.
 */
export interface PluginContext {
  tools: ToolRegistryView;
  channels: ChannelRegistryView;
  providers: ProviderRegistryView;
  embeddings: EmbeddingRegistryView;
  memoryBackends: MemoryBackendRegistryView;
  taskBackends: TaskBackendRegistryView;
  repoBackends: RepoBackendRegistryView;
  sandboxBackends: SandboxBackendRegistryView;
  uiProviders: UiProviderRegistryView;
  /** Register a clock and/or timezone source selected by `time.provider`. */
  timeProviders: TimeProviderRegistryView;
  /**
   * Register a custom workflow step executor. Call this before the workflow
   * engine is created (i.e. in your plugin's top-level function body) so the
   * factory is included in the engine's executor set on startup.
   *
   * The registered factory receives the same {@link StepExecutorContext} as
   * the built-ins, providing access to `runtime`, `db`, `resolveOutbound`,
   * and the email plumbing. Only the fields you need are required.
   *
   * Registering for an existing `type` string (e.g. `"shell"`) overrides the
   * built-in for that type — last-registered factory wins.
   *
   * @example
   * ```ts
   * ctx.stepExecutors.register("my_step", (ctx) => new MyStepExecutor({ db: ctx.db }));
   * ```
   */
  stepExecutors: StepExecutorRegistryView;
  /**
   * Slash-command surface — register chat commands the channels expose.
   *
   * Transport-neutral: you describe the command and its options, and each
   * channel adapts that onto its own command surface (Discord today). Unlike
   * HTTP routes these cannot be namespaced — chat platforms use a flat command
   * namespace with no separator — so `register` throws on a name that is
   * built-in or already taken rather than silently shadowing it.
   *
   * Returns a disposer; call it from your plugin's `stop()` so a disabled
   * plugin stops advertising its commands.
   *
   * @example
   * ```ts
   * ctx.commands.register({
   *   name: "instance",
   *   description: "Show or switch the running TAI instance",
   *   options: [{ name: "name", description: "Instance", type: "string" }],
   *   handler: async (inv) => ({ content: `switching to ${inv.options.name}` }),
   * });
   * ```
   */
  commands: SlashCommandRegistryView;
  /**
   * Typed pub/sub bus for runtime lifecycle events. Plugins subscribe via
   * `ctx.events.on(name, handler)` and get back a disposer.
   *
   * Slice 1 of the platform vision (`docs/platform-vision.md`): the bus
   * ships, but emissions land incrementally as later slices wire the
   * underlying subsystems through it. Subscribing is safe today — your
   * handler simply won't fire until the corresponding event starts
   * being emitted.
   */
  events: EventBus;
  /**
   * HTTP route surface — register routes the server mounts on its router.
   * Routes namespace under `/api/ext/<plugin-id>/…` so a plugin can't shadow
   * a core route. See `http/registry.ts` for the descriptor shape, the
   * framework-agnostic request/response types, the `auth: "none"` exemption,
   * and the `absolute` escape hatch for legacy paths.
   *
   * Backed by the runtime's {@link HttpRouteRegistry} when `ctx.runtime` is
   * present; a context built without a runtime gets a throwaway registry so
   * `register` is always safe to call (the routes just go nowhere).
   */
  http: HttpRegistryView;
  /**
   * The live {@link AgentRuntime}, when the host built the context with one
   * (the CLI / server always do). Optional because a library consumer can
   * build a bare context for registry-shaped plugins that only need the
   * `register` views above.
   *
   * Plugins that subscribe to the event bus and act on runtime state — the
   * default `builtin:*` plugins do — read `ctx.runtime.db`,
   * `ctx.runtime.getConfig()`, `ctx.runtime.getOutbound()`, etc. A plugin
   * that needs the runtime should early-return when it's absent rather than
   * assume it's present:
   *
   *     export default ((ctx) => {
   *       if (!ctx.runtime) return;
   *       ...
   *     }) satisfies Plugin;
   */
  runtime?: AgentRuntime;
  /**
   * The per-entry `config` bag from this plugin's `config.plugins:` entry
   * (`{ module, config: { ... } }`). Empty object when the entry is a bare
   * string or declares no `config`. Plugins read their own settings from
   * here — e.g. `builtin:stall-guard` reads `ctx.config.maxStallRetries`.
   */
  config: Record<string, unknown>;
}

/**
 * A plugin is a function the runtime calls with a context. The function may
 * register factories, mount channels, etc. Async is supported so plugins
 * can do setup work (e.g. wait on a remote handshake) before returning.
 *
 * It may return a **disposer** — a function that tears down whatever the
 * plugin started (event subscriptions, timers, connections). The loader
 * captures it on {@link LoadedPlugin.stop} so the host can dispose all
 * plugins on shutdown / reload. Sync or async; returning nothing means the
 * plugin has no teardown.
 *
 * Author with:
 *
 *     import type { Plugin } from "@tailored-ai/core";
 *     export default ((ctx) => {
 *       const sub = ctx.events.on("agent.completed", handle);
 *       return () => sub.dispose();
 *     }) satisfies Plugin;
 */
export type PluginDisposer = () => void | Promise<void>;

/**
 * One thing a plugin registers, declared in {@link PluginMeta.registers}.
 * `kind` matches the PluginContext namespace ("provider", "tool", "channel",
 * …); the open string union keeps future namespaces representable without a
 * core release. `configKey` is the config path users set to activate and
 * configure the registration — the link between the `plugins:` entry that
 * loads code and the config block that turns features on.
 */
export interface PluginRegistration {
  kind:
    | "tool"
    | "channel"
    | "provider"
    | "embedding"
    | "memoryBackend"
    | "taskBackend"
    | "repoBackend"
    | "sandboxBackend"
    | "uiProvider"
    | "timeProvider"
    | "stepExecutor"
    | "eventSubscriber"
    | "httpRoutes"
    | (string & {});
  id: string;
  /** Config path that configures it, e.g. "providers.bedrock" or "tools.gmail". */
  configKey?: string;
}

/**
 * Optional plugin self-description, exported as a named `meta` export next
 * to the default register function:
 *
 *     export const meta: PluginMeta = {
 *       name: "AWS Bedrock provider",
 *       description: "Bedrock-hosted models via the Converse API.",
 *       registers: [{ kind: "provider", id: "bedrock", configKey: "providers.bedrock" }],
 *     };
 *
 * Like {@link Plugin}, this is a type-only contract — plugins keep zero
 * runtime dependency on core. The loader captures it onto
 * `LoadedPlugin.meta`; `GET /api/plugins` and `tai plugin list` surface it.
 */
export interface PluginMeta {
  /** Human-readable name for UIs. Falls back to the module specifier. */
  name?: string;
  /** One or two sentences on what the plugin does. */
  description?: string;
  /** What this plugin registers — powers discoverability in UIs and error hints. */
  registers?: PluginRegistration[];
}

/**
 * Optional plugin-owned config validation, exported as a named
 * `validateConfig` export. Core's own `validateConfig` deliberately knows
 * nothing about plugin config shapes (the plugin owns them), so this is
 * where a plugin checks its blocks and returns human-readable warnings:
 *
 *     export function validateConfig(config: AgentConfig): string[] {
 *       const cfg = config.providers.bedrock as BedrockConfig | undefined;
 *       return cfg && !cfg.defaultModel ? ["providers.bedrock.defaultModel is empty"] : [];
 *     }
 *
 * Warnings only — a plugin cannot veto startup (factories already fail fast
 * for hard errors). The loader collects them onto `LoadedPlugin.warnings`
 * and prints them alongside core's config warnings.
 */
export type PluginConfigValidator = (config: import("./config.js").AgentConfig) => string[];
// Each arm kept distinct (rather than `Promise<void | PluginDisposer>`) so
// `void` never appears inside a union — covers sync no-return, sync disposer,
// async no-return, and async disposer.
export type Plugin = (ctx: PluginContext) => void | PluginDisposer | Promise<void> | Promise<PluginDisposer>;

export interface CreatePluginContextOptions {
  /**
   * Event bus to expose as `ctx.events`. The runtime passes its own
   * `runtime.events` so plugin subscriptions land on the same bus the
   * runtime emits to. Tests + standalone callers can omit this and get
   * a fresh in-memory bus.
   */
  events?: EventBus;
  /**
   * The live runtime to expose as `ctx.runtime`. The CLI / server pass
   * their {@link AgentRuntime} so event-driven plugins can read runtime
   * state. When set and `events` is omitted, the runtime's own bus is used
   * so subscriptions and emissions share one instance.
   */
  runtime?: AgentRuntime;
  /**
   * Default per-plugin `config` bag for `ctx.config`. {@link loadPlugins}
   * overrides this per entry, so this is only the fallback for a context
   * built outside the loader. Defaults to `{}`.
   */
  config?: Record<string, unknown>;
  /**
   * Namespace prefix for `ctx.http` route registration — typically the
   * plugin's module id. {@link loadPlugins} sets this per entry so each
   * plugin's routes land under `/api/ext/<id>/`. Omit for a context built
   * outside the loader; routes then land directly under `/api/ext/`.
   */
  httpPrefix?: string;
  /**
   * Called with the disposer for every registration made through this context.
   *
   * {@link loadPlugins} passes a per-entry collector so a plugin's
   * registrations can be undone as a unit when it is unloaded, without the
   * plugin author tracking them by hand. Omit it and registrations behave
   * exactly as they did before: the disposer is still returned to the caller,
   * nobody else holds it.
   */
  collect?: (dispose: Disposer) => void;
}

/**
 * Route registration returns its own disposer already; this only tees a copy
 * into the collector so plugin teardown covers routes as well. Routes are the
 * clearest case for the collector: the underlying registry deliberately
 * survives `reload()` because the HTTP router cannot unmount, so a route left
 * behind by an unloaded plugin stays reachable until the process restarts.
 */
function collectingHttp(view: HttpRegistryView, collect: ((dispose: Disposer) => void) | undefined): HttpRegistryView {
  if (!collect) return view;
  return {
    register: (descriptor) => {
      const dispose = view.register(descriptor);
      collect(dispose);
      return dispose;
    },
    mount: (prefix, routes) => {
      const dispose = view.mount(prefix, routes);
      collect(dispose);
      return dispose;
    },
  };
}

/**
 * Build a {@link PluginContext} that delegates to the existing module-scope
 * register* functions. This is the bridge that makes the new contract work
 * today without forcing every internal registry to migrate to a per-runtime
 * instance first — that migration happens in a follow-up under #47.
 *
 * Pass this to {@link loadPlugins} so plugin imports that export a
 * `default(ctx)` function get invoked with the right shape.
 */
export function createPluginContext(opts: CreatePluginContextOptions = {}): PluginContext {
  const { runtime, collect } = opts;
  // Hand every registration's disposer to the collector on the way out, while
  // still returning it to the caller. One wrapper rather than ten call sites
  // that each have to remember.
  const collecting =
    <A extends unknown[]>(fn: (...args: A) => Disposer) =>
    (...args: A): Disposer => {
      const dispose = fn(...args);
      collect?.(dispose);
      return dispose;
    };
  // Routes register against the runtime's registry so the server can read
  // them after the runtime is built. A context with no runtime — or a partial
  // runtime stub that predates the seam — gets a throwaway registry, so
  // `register` stays safe and the routes simply go nowhere.
  const httpRegistry =
    typeof opts.runtime?.getHttpRoutes === "function" ? opts.runtime.getHttpRoutes() : new HttpRouteRegistry();
  return {
    tools: { register: collecting(registerToolFactory) },
    channels: { register: collecting(registerChannelFactory) },
    providers: { register: collecting(registerProviderFactory) },
    embeddings: { register: collecting(registerEmbeddingFactory) },
    memoryBackends: { register: collecting(registerMemoryBackendFactory) },
    taskBackends: { register: collecting(registerTaskBackendFactory) },
    repoBackends: { register: collecting(registerRepoBackendFactory) },
    sandboxBackends: { register: collecting(registerSandboxFactory) },
    uiProviders: { register: collecting(registerUiProviderFactory) },
    timeProviders: { register: collecting(registerTimeProviderFactory) },
    http: collectingHttp(createHttpRegistryView(httpRegistry, opts.httpPrefix), collect),
    // Step executors are registered into the runtime's per-instance registry
    // so factories reach the same registry that createWorkflowEngine reads.
    // When no runtime is available (bare/test context) the call is a no-op —
    // the plugin simply won't have its executor included in any engine created
    // from a different runtime instance.
    stepExecutors: {
      register(type: string, factory: StepExecutorFactory): Disposer {
        // No runtime means no registry to register into, so the disposer has
        // nothing to undo. Returning a no-op keeps the contract total rather
        // than making every caller check.
        const dispose = runtime?.getStepExecutorRegistry().registerFactory(type, factory);
        if (!dispose) return () => {};
        collect?.(dispose);
        return dispose;
      },
    },
    // Process-wide, like the channel/provider factory registries: the channels
    // that serve these commands read the same module-level registry, and the
    // Discord client re-syncs from it on every config reload.
    commands: {
      register: collecting((descriptor: SlashCommandDescriptor) => slashCommandRegistry.register(descriptor)),
    },
    // Prefer an explicit bus; else the runtime's own bus so plugin
    // subscriptions land where the runtime emits; else a fresh bus.
    events: opts.events ?? runtime?.events ?? new TypedEventBus(),
    runtime,
    config: opts.config ?? {},
  };
}
