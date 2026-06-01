/**
 * Built-in memory backend registration. Importing this module side-effect-
 * registers "builtin" as the default memory backend factory. The CLI gets
 * this for free via the core barrel import; tests can register their own
 * factory and unregister "builtin" if they need to.
 */
import { registerMemoryBackendFactory } from "./registry.js";
import { SqliteMemoryBackend } from "./sqlite-backend.js";

registerMemoryBackendFactory("builtin", (runtime) => new SqliteMemoryBackend(runtime.db));
