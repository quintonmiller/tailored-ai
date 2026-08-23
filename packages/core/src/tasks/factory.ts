import type Database from "better-sqlite3";
import type { AgentConfig } from "../config.js";
import { type Disposer, Registry } from "../registry.js";
import { BeadsTaskBackend } from "./beads.js";
import { BeansTaskBackend } from "./beans.js";
import { GitHubTaskBackend } from "./github.js";
import type { TaskBackend } from "./interface.js";
import { NativeTaskBackend } from "./native.js";

export type TaskBackendFactory = (config: AgentConfig, db: Database.Database) => TaskBackend;

export const taskBackendFactoryRegistry = new Registry<TaskBackendFactory>("task-backend");

export function registerTaskBackendFactory(id: string, factory: TaskBackendFactory): Disposer {
  return taskBackendFactoryRegistry.register(id, factory);
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
  return new GitHubTaskBackend({ repo, token, agentRoles: deriveAgentRoles(config, asStringArray(opts.agentRoles)) });
});

/**
 * The set of names the GitHub backend treats as TAI agent roles (routed via
 * `agent:<name>` labels instead of GH's assignees API). Derived from the
 * install's own config rather than a hardcoded personal list (#204):
 *   - every configured agent (`config.agents` keys),
 *   - the task-watcher's default agent (`config.taskWatcher.agent`/`.profile`),
 *   - any extra names from `tasks.options.agentRoles`.
 * Returns undefined when the union is empty so the backend's own default
 * (empty set) applies. Exported for tests.
 */
export function deriveAgentRoles(config: AgentConfig, extra: string[] | undefined): string[] | undefined {
  const roles = new Set<string>(extra ?? []);
  for (const name of Object.keys(config.agents ?? {})) roles.add(name);
  const watcherAgent = config.taskWatcher?.agent ?? config.taskWatcher?.profile;
  if (watcherAgent) roles.add(watcherAgent);
  return roles.size > 0 ? Array.from(roles) : undefined;
}

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
