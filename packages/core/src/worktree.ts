import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type BranchStrategy =
  | { type: "head" }
  | { type: "branch"; branch: string }
  | { type: "merge-to-head"; branch?: string };

export interface CreateWorktreeOptions {
  /** Path to the host git repo. Relative paths resolve against process.cwd(). */
  repoDir: string;
  strategy: BranchStrategy;
  /** Where to create the worktree. Defaults to <repoDir>/.worktrees/<branch>. */
  worktreePath?: string;
}

export interface Worktree {
  /** Absolute path to the worktree on disk. The same as repoDir for the "head" strategy. */
  readonly path: string;
  /** Branch the worktree is checked out on. */
  readonly branch: string;
  /** Branch strategy used when creating the worktree. */
  readonly strategy: BranchStrategy;
  /**
   * Tear down the worktree. For "branch" / "merge-to-head" strategies:
   *   - if the worktree has uncommitted changes or unmerged conflicts, the
   *     worktree is preserved on disk and `preservedPath` is returned;
   *   - otherwise the worktree is removed and the branch is left intact.
   * For "head", this is a no-op.
   */
  cleanup(): Promise<{ preservedPath?: string }>;
  /**
   * For "merge-to-head": fast-forward (or --no-ff merge) the worktree branch
   * back into the host repo's current HEAD. Returns whether the merge succeeded.
   * No-op for the other strategies.
   */
  mergeToHead?(): Promise<{ ok: true } | { ok: false; reason: string; branchPreserved: string }>;
}

async function git(repoDir: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const r = await exec("git", args, { cwd: repoDir, maxBuffer: 4 * 1024 * 1024 });
  return { stdout: r.stdout, stderr: r.stderr };
}

async function isClean(worktreePath: string): Promise<boolean> {
  try {
    const r = await git(worktreePath, ["status", "--porcelain"]);
    return r.stdout.trim().length === 0;
  } catch {
    return false;
  }
}

/**
 * Returns the on-disk path of an existing worktree currently checked out
 * on `branch`, or null if no such worktree exists. Used by createWorktree
 * to support reuse semantics — a branch can only be checked out in one
 * place, so the coder→reviewer handoff has to share the same worktree.
 */
async function findWorktreeForBranch(repoDir: string, branch: string): Promise<string | null> {
  try {
    const r = await git(repoDir, ["worktree", "list", "--porcelain"]);
    // Format: blocks of lines like `worktree <path>\nHEAD <sha>\nbranch refs/heads/<name>\n\n`
    const blocks = r.stdout
      .split(/\n\n/)
      .map((b) => b.trim())
      .filter(Boolean);
    for (const block of blocks) {
      const lines = block.split("\n");
      const worktreeLine = lines.find((l) => l.startsWith("worktree "));
      const branchLine = lines.find((l) => l.startsWith("branch "));
      if (!worktreeLine || !branchLine) continue;
      const path = worktreeLine.slice("worktree ".length).trim();
      const ref = branchLine.slice("branch ".length).trim();
      if (ref === `refs/heads/${branch}` || ref === branch) {
        return path;
      }
    }
  } catch {
    // git command failed — just say no worktree found and let createWorktree
    // try `worktree add` (which has its own error path).
  }
  return null;
}

async function getCurrentBranch(repoDir: string): Promise<string> {
  const r = await git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return r.stdout.trim();
}

function defaultBranchName(): string {
  return `agent/${Date.now().toString(36)}`;
}

/**
 * Create (or reuse) a git worktree according to the given branch strategy.
 *
 * Strategies:
 *  - `head`           — no worktree; agent works directly in repoDir on the
 *                        current branch. Cleanup is a no-op.
 *  - `branch`         — creates a fresh worktree on a named branch. Cleanup
 *                        removes the worktree iff clean; the branch is left.
 *  - `merge-to-head`  — same as `branch`, plus a `mergeToHead()` helper that
 *                        merges the branch into the host's current HEAD using
 *                        `--no-ff`. On merge conflict, the branch is preserved
 *                        for manual resolution.
 */
export async function createWorktree(opts: CreateWorktreeOptions): Promise<Worktree> {
  const repoDir = isAbsolute(opts.repoDir) ? opts.repoDir : resolve(process.cwd(), opts.repoDir);

  if (opts.strategy.type === "head") {
    const branch = await getCurrentBranch(repoDir);
    return {
      path: repoDir,
      branch,
      strategy: opts.strategy,
      async cleanup() {
        return {};
      },
    };
  }

  const branch = opts.strategy.type === "branch" ? opts.strategy.branch : (opts.strategy.branch ?? defaultBranchName());
  const wtPath = opts.worktreePath ?? join(repoDir, ".worktrees", branch.replace(/[^A-Za-z0-9._/-]/g, "-"));

  // Ensure parent dir exists for git's --mkdir-equivalent behavior.
  // (`git worktree add` accepts the path and creates it itself, but the parent must exist.)
  const parent = dirname(wtPath);
  if (!existsSync(parent)) {
    await exec("mkdir", ["-p", parent]);
  }

  // Reuse-existing semantics (Phase 5+6 — coder/reviewer handoffs):
  // if a worktree on this branch already exists (e.g. coder left it
  // around after a partial commit), reuse it. Otherwise create fresh.
  // This is what lets the reviewer run on the coder's branch without
  // racing the "path already exists" error from `git worktree add`.
  const existingWorktreePath = await findWorktreeForBranch(repoDir, branch);
  if (existingWorktreePath) {
    // Reuse the existing worktree. If the caller asked for a different
    // path, log it but use what's already there — a branch can only have
    // one checkout at a time.
    if (existingWorktreePath !== wtPath) {
      // Quiet: this is expected when the caller doesn't override worktreePath.
    }
  } else {
    // -b creates the branch from HEAD if it doesn't exist; if the branch
    // already exists but no worktree owns it, plain `worktree add` checks
    // it out.
    const branches = (await git(repoDir, ["branch", "--list", branch])).stdout.trim();
    if (branches) {
      await git(repoDir, ["worktree", "add", wtPath, branch]);
    } else {
      await git(repoDir, ["worktree", "add", "-b", branch, wtPath]);
    }
  }
  const finalPath = existingWorktreePath ?? wtPath;

  const cleanup = async (): Promise<{ preservedPath?: string }> => {
    const clean = await isClean(finalPath);
    if (!clean) return { preservedPath: finalPath };
    try {
      await git(repoDir, ["worktree", "remove", finalPath]);
    } catch {
      // Force remove if git refuses (e.g. locked).
      await git(repoDir, ["worktree", "remove", "--force", finalPath]).catch(() => {});
      await rm(finalPath, { recursive: true, force: true }).catch(() => {});
    }
    return {};
  };

  if (opts.strategy.type === "branch") {
    return { path: finalPath, branch, strategy: opts.strategy, cleanup };
  }

  // merge-to-head
  const strategy = opts.strategy;
  return {
    path: finalPath,
    branch,
    strategy,
    cleanup,
    async mergeToHead() {
      try {
        await git(repoDir, ["merge", "--no-ff", branch]);
        return { ok: true };
      } catch (err) {
        // Abort the half-merged state so the host repo is left clean; the branch is preserved.
        await git(repoDir, ["merge", "--abort"]).catch(() => {});
        return {
          ok: false,
          reason: (err as Error).message,
          branchPreserved: branch,
        };
      }
    },
  };
}

/**
 * Stash any modified-tracked files in `repoDir` so a subsequent merge or
 * worktree cleanup isn't blocked. Untracked files are deliberately left alone
 * (matches the mmo sandcastle autostash pattern). Returns a `pop()` to restore.
 */
export async function autoStash(
  repoDir: string,
  label = `autostash-${Date.now().toString(36)}`,
): Promise<{
  stashed: boolean;
  pop(): Promise<{ ok: boolean; conflict?: boolean }>;
}> {
  const dirty = (await git(repoDir, ["diff", "--name-only", "HEAD"])).stdout.trim().length > 0;
  if (!dirty) {
    return {
      stashed: false,
      async pop() {
        return { ok: true };
      },
    };
  }
  await git(repoDir, ["stash", "push", "-m", label]);
  return {
    stashed: true,
    async pop() {
      const top = (await git(repoDir, ["stash", "list", "--format=%gs", "-1"])).stdout.trim();
      if (!top.includes(label)) {
        // Someone created another stash in between; the user must resolve manually.
        return { ok: false };
      }
      try {
        await git(repoDir, ["stash", "pop"]);
        return { ok: true };
      } catch {
        return { ok: false, conflict: true };
      }
    },
  };
}
