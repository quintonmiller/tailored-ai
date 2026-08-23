import { type Disposer, Registry } from "../registry.js";
import type { AgentRuntime } from "../runtime.js";
import type { MemoryBackend } from "./interface.js";

/**
 * Construct a memory backend for the active runtime. May read its own
 * slice of config from `memory.backend.<id>`. Sync or async — the
 * registry awaits either.
 */
export type MemoryBackendFactory = (
  runtime: AgentRuntime,
  config: Record<string, unknown>,
) => Promise<MemoryBackend> | MemoryBackend;

export const memoryBackendFactoryRegistry = new Registry<MemoryBackendFactory>("memory-backend");

export function registerMemoryBackendFactory(id: string, factory: MemoryBackendFactory): Disposer {
  return memoryBackendFactoryRegistry.register(id, factory);
}

/**
 * Resolve the memory backend declared by `memory.backend.provider`
 * (defaults to "builtin"). The "builtin" id is registered by core on
 * module import — it adapts the existing SQLite `db/*-queries.ts`
 * modules behind the verb interface.
 *
 * Unknown ids throw with the list of known factories, mirroring
 * `createTaskBackend`. The CLI surfaces the error at startup; tests
 * exercise both the happy path and the error message.
 */
export async function resolveMemoryBackend(runtime: AgentRuntime): Promise<MemoryBackend> {
  const memCfg = (runtime.getConfig() as { memory?: { backend?: Record<string, unknown> } }).memory;
  const backendCfg = memCfg?.backend ?? {};
  const id = (typeof backendCfg.provider === "string" ? backendCfg.provider : undefined) ?? "builtin";

  const factory = memoryBackendFactoryRegistry.get(id);
  if (!factory) {
    const known = memoryBackendFactoryRegistry.list().join(", ") || "(none)";
    throw new Error(
      `No memory backend factory registered for "${id}". Known: ${known}. ` +
        `Register one with registerMemoryBackendFactory().`,
    );
  }

  const slice = backendCfg[id];
  const cfg = slice && typeof slice === "object" && !Array.isArray(slice) ? (slice as Record<string, unknown>) : {};
  return factory(runtime, cfg);
}
