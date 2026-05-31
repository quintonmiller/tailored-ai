import { execFile as execFileCb } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { autoStash, createWorktree } from "../worktree.js";

const exec = promisify(execFileCb);

async function git(cwd: string, args: string[]): Promise<string> {
  const r = await exec("git", args, { cwd });
  return r.stdout;
}

async function initRepo(cwd: string): Promise<void> {
  await git(cwd, ["init", "-q", "-b", "main"]);
  await git(cwd, ["config", "user.email", "test@example.com"]);
  await git(cwd, ["config", "user.name", "Tester"]);
  writeFileSync(join(cwd, "README.md"), "hello\n");
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-q", "-m", "initial"]);
}

let repo: string;

beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), "wt-test-"));
  await initRepo(repo);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("createWorktree — head strategy", () => {
  it("returns a worktree pointing at repoDir on the current branch", async () => {
    const wt = await createWorktree({ repoDir: repo, strategy: { type: "head" } });
    expect(wt.path).toBe(repo);
    expect(wt.branch).toBe("main");
    await wt.cleanup();
  });

  it("cleanup is a no-op", async () => {
    const wt = await createWorktree({ repoDir: repo, strategy: { type: "head" } });
    await expect(wt.cleanup()).resolves.toEqual({});
  });
});

describe("createWorktree — branch strategy", () => {
  it("creates a worktree on a fresh branch under .worktrees/", async () => {
    const wt = await createWorktree({ repoDir: repo, strategy: { type: "branch", branch: "agent/foo" } });
    expect(wt.branch).toBe("agent/foo");
    expect(wt.path).toContain(".worktrees");
    expect(existsSync(wt.path)).toBe(true);
    expect(existsSync(join(wt.path, "README.md"))).toBe(true);
    await wt.cleanup();
  });

  it("cleanup removes a clean worktree", async () => {
    const wt = await createWorktree({ repoDir: repo, strategy: { type: "branch", branch: "agent/clean" } });
    expect(existsSync(wt.path)).toBe(true);
    const res = await wt.cleanup();
    expect(res.preservedPath).toBeUndefined();
    expect(existsSync(wt.path)).toBe(false);
  });

  it("cleanup preserves a worktree with uncommitted changes", async () => {
    const wt = await createWorktree({ repoDir: repo, strategy: { type: "branch", branch: "agent/dirty" } });
    writeFileSync(join(wt.path, "newfile.txt"), "uncommitted");
    await git(wt.path, ["add", "newfile.txt"]);
    const res = await wt.cleanup();
    expect(res.preservedPath).toBe(wt.path);
    expect(existsSync(wt.path)).toBe(true);
  });
});

describe("createWorktree — merge-to-head strategy", () => {
  it("merges the worktree branch back to host HEAD", async () => {
    const wt = await createWorktree({ repoDir: repo, strategy: { type: "merge-to-head", branch: "agent/m" } });
    writeFileSync(join(wt.path, "added.txt"), "from agent\n");
    await git(wt.path, ["add", "added.txt"]);
    await git(wt.path, ["commit", "-q", "-m", "agent change"]);

    const merged = await wt.mergeToHead?.();
    expect(merged?.ok).toBe(true);
    expect(existsSync(join(repo, "added.txt"))).toBe(true);

    await wt.cleanup();
  });

  it("returns ok=false on merge conflict and preserves the branch", async () => {
    const wt = await createWorktree({ repoDir: repo, strategy: { type: "merge-to-head", branch: "agent/c" } });

    // Conflicting edits: agent edits README in worktree, host edits README in repo.
    writeFileSync(join(wt.path, "README.md"), "agent version\n");
    await git(wt.path, ["add", "README.md"]);
    await git(wt.path, ["commit", "-q", "-m", "agent change"]);

    writeFileSync(join(repo, "README.md"), "host version\n");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-q", "-m", "host change"]);

    const merged = await wt.mergeToHead?.();
    expect(merged?.ok).toBe(false);
    if (merged && !merged.ok) {
      expect(merged.branchPreserved).toBe("agent/c");
    }

    // Repo's tracked files should be back to clean (merge --abort), even though
    // the .worktrees/ directory is still untracked on disk.
    const status = await git(repo, ["status", "--porcelain", "--untracked-files=no"]);
    expect(status.trim()).toBe("");

    await wt.cleanup();
  });

  it("uses auto-generated branch name when none is provided", async () => {
    const wt = await createWorktree({ repoDir: repo, strategy: { type: "merge-to-head" } });
    expect(wt.branch).toMatch(/^agent\//);
    await wt.cleanup();
  });
});

describe("autoStash", () => {
  it("returns stashed=false when the repo has no modified tracked files", async () => {
    const s = await autoStash(repo);
    expect(s.stashed).toBe(false);
    const popped = await s.pop();
    expect(popped.ok).toBe(true);
  });

  it("stashes modified tracked files and pops them back", async () => {
    writeFileSync(join(repo, "README.md"), "modified\n");
    const s = await autoStash(repo, "test-tag");
    expect(s.stashed).toBe(true);

    // Working tree is clean while stashed.
    const status = await git(repo, ["status", "--porcelain"]);
    expect(status.trim()).toBe("");

    const popped = await s.pop();
    expect(popped.ok).toBe(true);

    // Modification is restored.
    const restored = await git(repo, ["status", "--porcelain"]);
    expect(restored.trim()).toContain("README.md");
  });
});
