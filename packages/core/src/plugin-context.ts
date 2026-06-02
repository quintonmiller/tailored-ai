/**
 * Plugin contract — the runtime hands the plugin a {@link PluginContext} and
 * the plugin uses it to extend behavior. Compare with the old side-effect
 * shape (modules that import core and call top-level `registerToolFactory(...)`):
 * that shape required the plugin to resolve `@tailored-ai/core` from its
 * install location, which broke for plugins installed via `tai plugin install`
 * outside the host's resolution tree (#47).
 *
 * Authors only need type imports:
 *
 *     import type { Plugin } from "@tailored-ai/core";
 *     export default ((ctx) => {
 *       ctx.tools.register("echo", () => [echoTool]);
 *     }) satisfies Plugin;
 *
 * The `import type` erases at compile time, so a plugin has *zero* runtime
 * dependency on core. Installation, resolution, and instance identity stop
 * being a problem.
 *
 * Every AgentRuntime owns a {@link Registries} bundle; its
 * {@link AgentRuntime.pluginContext} is the view passed to plugins.
 */

import { registerDiscordChannel } from "./channels/discord-builtin.js";
import { registerBuiltinMemoryBackend } from "./memory/builtin.js";
import { registerBuiltinProviders } from "./providers/factories.js";
import { registerBuiltinTaskBackends } from "./tasks/factory.js";
import { registerBuiltinOptionalTools } from "./tools/builtin-optional.js";
import type { ChannelFactory } from "./channels/registry.js";
import type { MemoryBackendFactory } from "./memory/registry.js";
import type { EmbeddingFactory, ProviderFactory } from "./providers/factories.js";
import type { TaskBackendFactory } from "./tasks/factory.js";
import type { ToolFactory } from "./tools/tool-factories.js";
import type { UiProviderFactory } from "./ui/registry.js";

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
 */
export type Plugin = (ctx: PluginContext) => void | Promise<void>;

/**
 * Seed the built-ins that ship with core (provider + embedding factories,
 * tool factories for browser_mediator and trusted_actions, the Discord
 * channel, SQLite memory backend, the four task backends) into the given
 * context. Called by AgentRuntime construction; embedders constructing
 * their own ctx for multi-runtime setups should call it themselves.
 *
 * Each factory remains gated on its own config block — this just makes
 * them resolvable by id.
 */
export function registerCoreBuiltins(ctx: PluginContext): void {
  registerBuiltinProviders(ctx);
  registerBuiltinOptionalTools(ctx);
  registerDiscordChannel(ctx);
  registerBuiltinMemoryBackend(ctx);
  registerBuiltinTaskBackends(ctx);
}
