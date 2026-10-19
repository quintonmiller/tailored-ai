/**
 * Core's own state providers, registered on import through the same registry
 * a plugin uses. Guarded because `register` warns on replace, and a reload
 * that re-imports must not look like a duplicate registration bug.
 */
import { MemoryStateProvider } from "./memory-provider.js";
import { registerStateProvider, stateProviderRegistry } from "./registry.js";
import { SqliteStateProvider } from "./sqlite-provider.js";

if (!stateProviderRegistry.has("sqlite")) {
  registerStateProvider("sqlite", (ctx) => {
    if (!ctx.db) {
      throw new Error('The "sqlite" state provider needs the runtime database, and this runtime has none.');
    }
    return new SqliteStateProvider(ctx.db, ctx.now);
  });
}

if (!stateProviderRegistry.has("memory")) {
  registerStateProvider("memory", (ctx) => {
    const history = ctx.options.history;
    return new MemoryStateProvider(ctx.now, typeof history === "number" ? { history } : {});
  });
}
