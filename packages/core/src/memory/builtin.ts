/**
 * Built-in SQLite memory backend registration. Recommended path is to call
 * {@link registerBuiltinMemoryBackend} against your runtime's PluginContext
 * during boot. The module-level side-effect stays during the deprecation
 * window — see #47.
 */
import type { PluginContext } from "../plugin-context.js";
import { type MemoryBackendFactory, registerMemoryBackendFactory } from "./registry.js";
import { SqliteMemoryBackend } from "./sqlite-backend.js";

const builtinFactory: MemoryBackendFactory = (runtime) => new SqliteMemoryBackend(runtime.db);

/** Register the built-in SQLite memory backend against the given context. */
export function registerBuiltinMemoryBackend(ctx: PluginContext): void {
  ctx.memoryBackends.register("builtin", builtinFactory);
}

/**
 * @deprecated Importing this module for side effects is going away. Prefer
 * {@link registerBuiltinMemoryBackend} called against your runtime's
 * PluginContext. See #47.
 */
registerMemoryBackendFactory("builtin", builtinFactory);
