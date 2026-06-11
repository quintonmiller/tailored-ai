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
import { type EventBus, TypedEventBus } from "./events.js";
import type { MemoryBackendFactory } from "./memory/registry.js";
import { registerMemoryBackendFactory } from "./memory/registry.js";
import type { EmbeddingFactory, ProviderFactory } from "./providers/factories.js";
import { registerEmbeddingFactory, registerProviderFactory } from "./providers/factories.js";
import type { RepoBackendFactory } from "./repo/factory.js";
import { registerRepoBackendFactory } from "./repo/factory.js";
import type { StepExecutorFactory } from "./resources/step-executor-registry.js";
import type { AgentRuntime } from "./runtime.js";
import type { TaskBackendFactory } from "./tasks/factory.js";
import { registerTaskBackendFactory } from "./tasks/factory.js";
import type { ToolFactory } from "./tools/tool-factories.js";
import { registerToolFactory } from "./tools/tool-factories.js";
import type { UiProviderFactory } from "./ui/registry.js";
import { registerUiProviderFactory } from "./ui/registry.js";

export interface ToolRegistryView {
  register(id: string, factory: ToolFactory): void;
}

export interface ChannelRegistryView {
  register(id: string, factory: ChannelFactory): void;
}

export interface ProviderRegistryView {
  register(id: string, factory: ProviderFactory): void;
}

export interface EmbeddingRegistryView {
  register(id: string, factory: EmbeddingFactory): void;
}

export interface MemoryBackendRegistryView {
  register(id: string, factory: MemoryBackendFactory): void;
}

export interface TaskBackendRegistryView {
  register(id: string, factory: TaskBackendFactory): void;
}

export interface RepoBackendRegistryView {
  register(id: string, factory: RepoBackendFactory): void;
}

export interface UiProviderRegistryView {
  register(id: string, factory: UiProviderFactory): void;
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
  register(type: string, factory: StepExecutorFactory): void;
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
  uiProviders: UiProviderRegistryView;
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
  const { runtime } = opts;
  return {
    tools: { register: registerToolFactory },
    channels: { register: registerChannelFactory },
    providers: { register: registerProviderFactory },
    embeddings: { register: registerEmbeddingFactory },
    memoryBackends: { register: registerMemoryBackendFactory },
    taskBackends: { register: registerTaskBackendFactory },
    repoBackends: { register: registerRepoBackendFactory },
    uiProviders: { register: registerUiProviderFactory },
    // Step executors are registered into the runtime's per-instance registry
    // so factories reach the same registry that createWorkflowEngine reads.
    // When no runtime is available (bare/test context) the call is a no-op —
    // the plugin simply won't have its executor included in any engine created
    // from a different runtime instance.
    stepExecutors: {
      register(type: string, factory: StepExecutorFactory): void {
        runtime?.getStepExecutorRegistry().registerFactory(type, factory);
      },
    },
    // Prefer an explicit bus; else the runtime's own bus so plugin
    // subscriptions land where the runtime emits; else a fresh bus.
    events: opts.events ?? runtime?.events ?? new TypedEventBus(),
    runtime,
    config: opts.config ?? {},
  };
}
