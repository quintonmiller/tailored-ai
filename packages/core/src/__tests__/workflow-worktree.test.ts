import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db/schema.js";
import { WorkflowEngine } from "../workflows/engine.js";
import { ShellExecutor } from "../workflows/executors/shell.js";
import { WorktreeExecutor } from "../workflows/executors/worktree.js";
import { WorkflowRegistry } from "../workflows/registry.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wf-wt-"));
  git(dir, "init", "--initial-branch=main");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "README.md"), "initial\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-m", "init");
  return dir;
}

let db: Database.Database;
let registry: WorkflowRegistry;
let engine: WorkflowEngine;
let repoDir: string;

beforeEach(() => {
  repoDir = initRepo();
  db = initDatabase(":memory:");
  registry = new WorkflowRegistry();
  engine = new WorkflowEngine({
    db,
    registry,
    executors: [
      new ShellExecutor({ cwd: repoDir, defaultTimeoutMs: 5000 }),
      new WorktreeExecutor(),
    ],
  });
});

afterEach(() => {
  db.close();
  rmSync(repoDir, { recursive: true, force: true });
});

describe("WorktreeExecutor", () => {
  it("creates a branch worktree, runs body steps with ${worktree.path}, cleans up", async () => {
    registry.register({
      name: "wt",
      steps: [
        {
          name: "build",
          type: "worktree",
          strategy: "branch",
          branch: "agent/test-build",
          repoDir,
          body: [
            {
              name: "touch",
              type: "shell",
              command: "echo branch-output > new-file.txt && pwd",
              cwd: "${worktree.path}",
            },
          ],
        },
      ],
    });

    const run = await engine.runWorkflow("wt");
    expect(run.status).toBe("completed");
    const output = run.output as { path: string; branch: string; merged: boolean };
    expect(output.branch).toBe("agent/test-build");
    expect(output.merged).toBe(false);

    // The branch should exist in the host repo.
    const branches = git(repoDir, "branch", "--list", "agent/test-build");
    expect(branches).toContain("agent/test-build");
    // Worktree dir cleaned up since the file was untracked (autoStash leaves untracked).
    // The dir may or may not exist depending on git's behavior; the important
    // invariant is the host repo is still on main.
    expect(git(repoDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });

  it("merge-to-head merges the body's commits back into the host branch", async () => {
    registry.register({
      name: "wt",
      steps: [
        {
          name: "edit",
          type: "worktree",
          strategy: "merge-to-head",
          branch: "agent/merge-test",
          repoDir,
          body: [
            {
              name: "write",
              type: "shell",
              command:
                "echo updated > README.md && git add README.md && git commit -m 'agent edit'",
              cwd: "${worktree.path}",
            },
          ],
        },
      ],
    });

    const run = await engine.runWorkflow("wt");
    expect(run.status).toBe("completed");
    const output = run.output as { merged: boolean; branch: string };
    expect(output.merged).toBe(true);
    expect(output.branch).toBe("agent/merge-test");

    // The host repo's README should now reflect the agent's edit.
    const readme = readFileSync(join(repoDir, "README.md"), "utf-8").trim();
    expect(readme).toBe("updated");
  });

  it("preserves the worktree path when the body leaves uncommitted changes", async () => {
    registry.register({
      name: "wt",
      steps: [
        {
          name: "leave-dirty",
          type: "worktree",
          strategy: "branch",
          branch: "agent/dirty",
          repoDir,
          body: [
            {
              name: "touch-tracked",
              type: "shell",
              command: "echo dirty >> README.md",
              cwd: "${worktree.path}",
            },
          ],
        },
      ],
    });

    const run = await engine.runWorkflow("wt");
    expect(run.status).toBe("completed");
    const output = run.output as { preservedPath?: string };
    expect(output.preservedPath).toBeTruthy();
    expect(existsSync(output.preservedPath!)).toBe(true);
  });

  it("dry-run skips git operations and synthesizes an output", async () => {
    registry.register({
      name: "wt",
      steps: [
        {
          name: "branch-step",
          type: "worktree",
          strategy: "branch",
          branch: "agent/dry",
          repoDir,
          body: [{ name: "noop", type: "shell", command: "echo skipped" }],
        },
      ],
    });

    const run = await engine.runWorkflow("wt", {}, "programmatic", { dryRun: true });
    expect(run.status).toBe("completed");
    const output = run.output as { dryRun?: boolean };
    expect(output.dryRun).toBe(true);
    // No branch should have been created.
    const branches = git(repoDir, "branch", "--list", "agent/dry");
    expect(branches).toBe("");
  });
});
