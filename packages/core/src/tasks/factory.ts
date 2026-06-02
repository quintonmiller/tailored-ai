import type Database from "better-sqlite3";
import type { AgentConfig } from "../config.js";
import type { PluginContext } from "../plugin-context.js";
import type { Registries } from "../registries.js";
import { BeadsTaskBackend } from "./beads.js";
import { BeansTaskBackend } from "./beans.js";
import { GitHubTaskBackend } from "./github.js";
import type { TaskBackend } from "./interface.js";
import { NativeTaskBackend } from "./native.js";

export type TaskBackendFactory = (config: AgentConfig, db: Database.Database) => TaskBackend;

const nativeFactory: TaskBackendFactory = (_config, db) => new NativeTaskBackend(db);

const githubFactory: TaskBackendFactory = (config) => {
  const cfg = config.tasks?.github;
  if (!cfg?.repo || !cfg?.token) {
    throw new Error('tasks.backend = "github" requires tasks.github.repo and tasks.github.token');
  }
  return new GitHubTaskBackend({ repo: cfg.repo, token: cfg.token });
};

const beansFactory: TaskBackendFactory = (config) =>
  new BeansTaskBackend({ path: config.tasks?.beans?.path });

const beadsFactory: TaskBackendFactory = (config) =>
  new BeadsTaskBackend({ db: config.tasks?.beads?.path });

/**
 * Seed the built-in task backend factories (native / github / beans / beads)
 * into the given context. Called by {@link registerCoreBuiltins} during
 * AgentRuntime construction.
 */
export function registerBuiltinTaskBackends(ctx: PluginContext): void {
  ctx.taskBackends.register("native", nativeFactory);
  ctx.taskBackends.register("github", githubFactory);
  ctx.taskBackends.register("beans", beansFactory);
  ctx.taskBackends.register("beads", beadsFactory);
}

/**
 * Construct the configured task backend. Defaults to `native` (SQLite) when no
 * `tasks.backend` is set, preserving existing behavior. Reads from the
 * runtime's task-backend registry; custom backends register via
 * `ctx.taskBackends.register` from a plugin.
 */
export function createTaskBackend(registries: Registries, config: AgentConfig, db: Database.Database): TaskBackend {
  const kind = config.tasks?.backend ?? "native";
  const factory = registries.taskBackends.get(kind);
  if (!factory) {
    const known = registries.taskBackends.list().join(", ") || "(none)";
    throw new Error(
      `Unsupported tasks.backend "${kind}". Known: ${known}. Register a custom backend via ctx.taskBackends.register in your plugin.`,
    );
  }
  return factory(config, db);
}
