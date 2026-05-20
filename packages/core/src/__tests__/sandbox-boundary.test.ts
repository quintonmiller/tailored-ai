/**
 * Sandbox-boundary checks for the file/exec tools. The bug we're guarding
 * against: a coder agent dispatched with a worktree at
 * /repo/.worktrees/agent/ptask_xxx-... can still issue
 * `write(path="/repo/packages/.../file.ts")` with an absolute path that
 * resolves outside the worktree — polluting main. See the
 * 2026-05-20 main-pollution incident.
 */
import { describe, expect, it } from "vitest";
import { checkExecBoundary, checkSandboxBoundary } from "../tools/sandbox-boundary.js";
import type { ToolContext } from "../tools/interface.js";

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: "test",
    workingDirectory: "/repo",
    env: {},
    ...overrides,
  };
}

describe("checkSandboxBoundary", () => {
  it("allows any path when no boundary is set", () => {
    const r = checkSandboxBoundary("/any/where", ctx());
    expect(r.ok).toBe(true);
  });

  it("allows the boundary path itself", () => {
    const r = checkSandboxBoundary(
      "/repo/.worktrees/agent/ptask_x",
      ctx({ workingDirectoryBoundary: "/repo/.worktrees/agent/ptask_x" }),
    );
    expect(r.ok).toBe(true);
  });

  it("allows descendants of the boundary", () => {
    const r = checkSandboxBoundary(
      "/repo/.worktrees/agent/ptask_x/packages/core/src/foo.ts",
      ctx({ workingDirectoryBoundary: "/repo/.worktrees/agent/ptask_x" }),
    );
    expect(r.ok).toBe(true);
  });

  it("rejects sibling paths under the parent repo (the main-pollution shape)", () => {
    const r = checkSandboxBoundary(
      "/repo/packages/core/src/foo.ts",
      ctx({ workingDirectoryBoundary: "/repo/.worktrees/agent/ptask_x" }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("outside the sandbox root");
  });

  it("rejects paths under a prefix-similar but distinct boundary", () => {
    // /repo/.worktrees/agent/ptask_x vs /repo/.worktrees/agent/ptask_xy
    const r = checkSandboxBoundary(
      "/repo/.worktrees/agent/ptask_xy/file.ts",
      ctx({ workingDirectoryBoundary: "/repo/.worktrees/agent/ptask_x" }),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects parent-traversal attempts (relative paths resolved upward)", () => {
    // `../foo.ts` inside the worktree resolves into the parent — boundary should catch it.
    const r = checkSandboxBoundary(
      "/repo/foo.ts",
      ctx({ workingDirectoryBoundary: "/repo/.worktrees/agent/ptask_x" }),
    );
    expect(r.ok).toBe(false);
  });
});

describe("checkExecBoundary", () => {
  const boundary = "/repo/.worktrees/agent/ptask_x";

  it("allows commands with no absolute paths", () => {
    const r = checkExecBoundary("pnpm test", ctx({ workingDirectoryBoundary: boundary }));
    expect(r.ok).toBe(true);
  });

  it("allows commands with absolute paths inside the worktree", () => {
    const r = checkExecBoundary(
      `git -C ${boundary}/packages/core status`,
      ctx({ workingDirectoryBoundary: boundary }),
    );
    expect(r.ok).toBe(true);
  });

  it("allows absolute paths to unrelated filesystem (e.g. /tmp, /etc)", () => {
    const r1 = checkExecBoundary("cat /etc/hostname", ctx({ workingDirectoryBoundary: boundary }));
    expect(r1.ok).toBe(true);
    const r2 = checkExecBoundary("ls /tmp/", ctx({ workingDirectoryBoundary: boundary }));
    expect(r2.ok).toBe(true);
  });

  it("rejects `git -C <repo-root>` parent-repo escape", () => {
    const r = checkExecBoundary(
      `git -C /repo status`,
      ctx({ workingDirectoryBoundary: boundary }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("outside the worktree");
  });

  it("rejects `cat <parent-repo-source-file>`", () => {
    const r = checkExecBoundary(
      `cat /repo/packages/core/src/foo.ts`,
      ctx({ workingDirectoryBoundary: boundary }),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects --cwd=/escape style args", () => {
    const r = checkExecBoundary(
      `node --cwd=/repo build.js`,
      ctx({ workingDirectoryBoundary: boundary }),
    );
    expect(r.ok).toBe(false);
  });

  it("no-ops when boundary isn't set", () => {
    const r = checkExecBoundary("git -C /anywhere status", ctx());
    expect(r.ok).toBe(true);
  });

  it("no-ops when boundary isn't a worktree shape (no /.worktrees/ segment)", () => {
    // If somebody sets the boundary to /repo directly, the heuristic
    // can't infer a parent repo, so we conservatively skip the check.
    const r = checkExecBoundary(
      "git -C /repo/somewhere status",
      ctx({ workingDirectoryBoundary: "/repo" }),
    );
    expect(r.ok).toBe(true);
  });
});
