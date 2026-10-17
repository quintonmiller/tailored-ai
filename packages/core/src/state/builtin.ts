/**
 * Core's own state provider, registered on import through the same registry
 * a plugin uses. Guarded because `register` warns on replace, and a reload
 * that re-imports must not look like a duplicate registration bug.
 */
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
