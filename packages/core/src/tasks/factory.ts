import type Database from "better-sqlite3";
import type { AgentConfig } from "../config.js";
import { Registry } from "../registry.js";
import { BeadsTaskBackend } from "./beads.js";
import { BeansTaskBackend } from "./beans.js";
import { GitHubTaskBackend } from "./github.js";
import type { TaskBackend } from "./interface.js";
import { NativeTaskBackend } from "./native.js";

export type TaskBackendFactory = (config: AgentConfig, db: Database.Database) => TaskBackend;

export const taskBackendFactoryRegistry = new Registry<TaskBackendFactory>("task-backend");

/**
 * @deprecated Prefer the {@link Plugin} contract: call
 * `ctx.taskBackends.register(id, factory)` from a plugin's `default(ctx)`.
 * This free function will be removed once internal consumers migrate — see #47.
 */
export function registerTaskBackendFactory(id: string, factory: TaskBackendFactory): void {
  taskBackendFactoryRegistry.register(id, factory);
}

// Built-in task backends register on module load.

taskBackendFactoryRegistry.register("native", (_config, db) => new NativeTaskBackend(db));

taskBackendFactoryRegistry.register("github", (config) => {
  const cfg = config.tasks?.github;
  if (!cfg?.repo || !cfg?.token) {
    throw new Error('tasks.backend = "github" requires tasks.github.repo and tasks.github.token');
  }
  return new GitHubTaskBackend({ repo: cfg.repo, token: cfg.token });
});

taskBackendFactoryRegistry.register("beans", (config) => new BeansTaskBackend({ path: config.tasks?.beans?.path }));

taskBackendFactoryRegistry.register("beads", (config) => new BeadsTaskBackend({ db: config.tasks?.beads?.path }));

/**
 * Construct the configured task backend. Defaults to `native` (SQLite) when no
 * `tasks.backend` is set, preserving existing behavior. Custom backends
 * register via `registerTaskBackendFactory`.
 */
export function createTaskBackend(config: AgentConfig, db: Database.Database): TaskBackend {
  const kind = config.tasks?.backend ?? "native";
  const factory = taskBackendFactoryRegistry.get(kind);
  if (!factory) {
    const known = taskBackendFactoryRegistry.list().join(", ") || "(none)";
    throw new Error(
      `Unsupported tasks.backend "${kind}". Known: ${known}. Register a custom backend with registerTaskBackendFactory().`,
    );
  }
  return factory(config, db);
}
