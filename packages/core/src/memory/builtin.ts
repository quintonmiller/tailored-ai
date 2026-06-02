/**
 * Built-in SQLite memory backend. Seeded into every runtime's
 * memory-backend registry by {@link registerCoreBuiltins}.
 */
import type { PluginContext } from "../plugin-context.js";
import type { MemoryBackendFactory } from "./registry.js";
import { SqliteMemoryBackend } from "./sqlite-backend.js";

const builtinFactory: MemoryBackendFactory = (runtime) => new SqliteMemoryBackend(runtime.db);

/** Register the built-in SQLite memory backend against the given context. */
export function registerBuiltinMemoryBackend(ctx: PluginContext): void {
  ctx.memoryBackends.register("builtin", builtinFactory);
}
