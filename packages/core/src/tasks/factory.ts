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

export function registerTaskBackendFactory(id: string, factory: TaskBackendFactory): void {
  taskBackendFactoryRegistry.register(id, factory);
}

// Built-in task backends register on module load.

// Built-in backends read their settings from the generic `tasks.options`
// bag — exactly how a third-party backend would — so core privileges no
// built-in. (Legacy `tasks.github`/`beans`/`beads` blocks are folded into
// `options` at load by migrateTaskBackendConfig.)

taskBackendFactoryRegistry.register("native", (_config, db) => new NativeTaskBackend(db));

taskBackendFactoryRegistry.register("github", (config) => {
  const opts = config.tasks?.options ?? {};
  const repo = asString(opts.repo);
  const token = asString(opts.token);
  if (!repo || !token) {
    throw new Error('tasks.backend = "github" requires tasks.options.repo and tasks.options.token');
  }
  return new GitHubTaskBackend({ repo, token, agentRoles: asStringArray(opts.agentRoles) });
});

taskBackendFactoryRegistry.register(
  "beans",
  (config) => new BeansTaskBackend({ path: asString(config.tasks?.options?.path) }),
);

taskBackendFactoryRegistry.register(
  "beads",
  (config) => new BeadsTaskBackend({ db: asString(config.tasks?.options?.path) }),
);

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
}

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
