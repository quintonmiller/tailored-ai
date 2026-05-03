import type Database from "better-sqlite3";
import type { AgentConfig } from "../config.js";
import { GitHubTaskBackend } from "./github.js";
import type { TaskBackend } from "./interface.js";
import { NativeTaskBackend } from "./native.js";

/**
 * Construct the configured task backend. Defaults to `native` (SQLite) when
 * no `tasks.backend` is set, preserving existing behavior.
 */
export function createTaskBackend(config: AgentConfig, db: Database.Database): TaskBackend {
  const kind = config.tasks?.backend ?? "native";
  switch (kind) {
    case "native":
      return new NativeTaskBackend(db);
    case "github": {
      const cfg = config.tasks?.github;
      if (!cfg?.repo || !cfg?.token) {
        throw new Error('tasks.backend = "github" requires tasks.github.repo and tasks.github.token');
      }
      return new GitHubTaskBackend({ repo: cfg.repo, token: cfg.token });
    }
    default:
      throw new Error(
        `Unsupported tasks.backend "${kind}". Supported: native, github. (beans/beads adapters not yet implemented.)`,
      );
  }
}
