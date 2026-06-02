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
import type { MemoryBackendFactory } from "./memory/registry.js";
import { registerMemoryBackendFactory } from "./memory/registry.js";
import type { EmbeddingFactory, ProviderFactory } from "./providers/factories.js";
import { registerEmbeddingFactory, registerProviderFactory } from "./providers/factories.js";
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

export interface UiProviderRegistryView {
  register(id: string, factory: UiProviderFactory): void;
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
  uiProviders: UiProviderRegistryView;
}

/**
 * A plugin is a function the runtime calls with a context. The function may
 * register factories, mount channels, etc. Async is supported so plugins
 * can do setup work (e.g. wait on a remote handshake) before returning.
 *
 * Author with:
 *
 *     import type { Plugin } from "@tailored-ai/core";
 *     export default ((ctx) => { ... }) satisfies Plugin;
 */
export type Plugin = (ctx: PluginContext) => void | Promise<void>;

/**
 * Build a {@link PluginContext} that delegates to the existing module-scope
 * register* functions. This is the bridge that makes the new contract work
 * today without forcing every internal registry to migrate to a per-runtime
 * instance first — that migration happens in a follow-up under #47.
 *
 * Pass this to {@link loadPlugins} so plugin imports that export a
 * `default(ctx)` function get invoked with the right shape.
 */
export function createPluginContext(): PluginContext {
  return {
    tools: { register: registerToolFactory },
    channels: { register: registerChannelFactory },
    providers: { register: registerProviderFactory },
    embeddings: { register: registerEmbeddingFactory },
    memoryBackends: { register: registerMemoryBackendFactory },
    taskBackends: { register: registerTaskBackendFactory },
    uiProviders: { register: registerUiProviderFactory },
  };
}
