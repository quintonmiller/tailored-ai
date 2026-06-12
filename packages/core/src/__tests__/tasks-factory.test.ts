/**
 * createTaskBackend resolution tests — built-ins are resolved through the
 * registry like any plugin, and read their settings from the generic
 * `tasks.options` bag rather than a privileged per-backend config block.
 */
import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../config.js";
import { initDatabase } from "../db/schema.js";
import { createTaskBackend, deriveAgentRoles } from "../tasks/factory.js";
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

describe("deriveAgentRoles (#204 — no hardcoded role list)", () => {
  it("returns undefined when nothing supplies roles", () => {
    expect(deriveAgentRoles({} as AgentConfig, undefined)).toBeUndefined();
  });

  it("derives roles from configured agent names", () => {
    const config = { agents: { coder: {}, reviewer: {}, planner: {} } } as unknown as AgentConfig;
    const roles = deriveAgentRoles(config, undefined)!;
    expect(new Set(roles)).toEqual(new Set(["coder", "reviewer", "planner"]));
  });

  it("includes the task-watcher default agent", () => {
    const config = {
      agents: { coder: {} },
      taskWatcher: { agent: "triage" },
    } as unknown as AgentConfig;
    expect(new Set(deriveAgentRoles(config, undefined)!)).toEqual(new Set(["coder", "triage"]));
  });

  it("unions in extra agentRoles from options without duplicates", () => {
    const config = { agents: { coder: {} } } as unknown as AgentConfig;
    const roles = deriveAgentRoles(config, ["coder", "external-bot"])!;
    expect(new Set(roles)).toEqual(new Set(["coder", "external-bot"]));
  });
});
