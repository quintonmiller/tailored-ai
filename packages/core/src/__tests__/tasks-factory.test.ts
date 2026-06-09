/**
 * createTaskBackend resolution tests — built-ins are resolved through the
 * registry like any plugin, and read their settings from the generic
 * `tasks.options` bag rather than a privileged per-backend config block.
 */
import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../config.js";
import { initDatabase } from "../db/schema.js";
import { createTaskBackend } from "../tasks/factory.js";
import { GitHubTaskBackend } from "../tasks/github.js";

function cfg(tasks?: AgentConfig["tasks"]): AgentConfig {
  return { tasks } as AgentConfig;
}

describe("createTaskBackend", () => {
  it("defaults to the native backend when unset", () => {
    const db = initDatabase(":memory:");
    expect(createTaskBackend(cfg(), db).name).toBe("native");
    db.close();
  });

  it("builds the github backend from tasks.options (no privileged block)", () => {
    const db = initDatabase(":memory:");
    const be = createTaskBackend(cfg({ backend: "github", options: { repo: "a/r", token: "t" } }), db);
    expect(be).toBeInstanceOf(GitHubTaskBackend);
    db.close();
  });

  it("throws a clear error when github options are missing", () => {
    const db = initDatabase(":memory:");
    expect(() => createTaskBackend(cfg({ backend: "github" }), db)).toThrow(
      /tasks\.options\.repo and tasks\.options\.token/,
    );
    db.close();
  });

  it("throws a helpful registry error for an unknown backend", () => {
    const db = initDatabase(":memory:");
    expect(() => createTaskBackend(cfg({ backend: "trello" }), db)).toThrow(
      /Unsupported tasks.backend "trello".*Known:/,
    );
    db.close();
  });
});
