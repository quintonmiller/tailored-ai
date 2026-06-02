/**
 * Bundle of factory registries. Each AgentRuntime owns one instance, which
 * eliminates the "two copies of core, two singletons" instance-identity
 * problem (#47). Plugins extend the runtime by registering into the
 * runtime's registries via a {@link PluginContext} view; readers (the
 * factories module, channel boot, ui resolver, …) accept the registries
 * as a parameter rather than reaching for a module-scope global.
 *
 * `Registries` is purely passive storage. Built-ins seed it through
 * {@link registerCoreBuiltins}; plugins seed it through their `default(ctx)`
 * hook.
 */
import type { ChannelFactory } from "./channels/registry.js";
import type { MemoryBackendFactory } from "./memory/registry.js";
import type { PluginContext } from "./plugin-context.js";
import type { EmbeddingFactory, ProviderFactory } from "./providers/factories.js";
import { Registry } from "./registry.js";
import type { TaskBackendFactory } from "./tasks/factory.js";
import type { ToolFactory } from "./tools/tool-factories.js";
import type { UiProviderFactory } from "./ui/registry.js";

export class Registries {
  readonly tools = new Registry<ToolFactory>("tool-factory");
  readonly channels = new Registry<ChannelFactory>("channel");
  readonly providers = new Registry<ProviderFactory>("provider");
  readonly embeddings = new Registry<EmbeddingFactory>("embedding");
  readonly memoryBackends = new Registry<MemoryBackendFactory>("memory-backend");
  readonly taskBackends = new Registry<TaskBackendFactory>("task-backend");
  readonly uiProviders = new Registry<UiProviderFactory>("ui-provider");

  /**
   * Build a PluginContext view over this bundle. The returned object exposes
   * only `register` per namespace — plugins can extend but can't enumerate
   * or unregister.
   */
  asPluginContext(): PluginContext {
    return {
      tools: { register: (id, f) => this.tools.register(id, f) },
      channels: { register: (id, f) => this.channels.register(id, f) },
      providers: { register: (id, f) => this.providers.register(id, f) },
      embeddings: { register: (id, f) => this.embeddings.register(id, f) },
      memoryBackends: { register: (id, f) => this.memoryBackends.register(id, f) },
      taskBackends: { register: (id, f) => this.taskBackends.register(id, f) },
      uiProviders: { register: (id, f) => this.uiProviders.register(id, f) },
    };
  }
}
