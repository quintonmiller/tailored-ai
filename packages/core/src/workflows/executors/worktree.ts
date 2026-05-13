import { resolveString } from "../scope.js";
import type { Scope } from "../scope.js";
import type { StepContext, StepExecutor, StepResult } from "../engine.js";
import type { WorkflowStepDef, WorktreeStep } from "../types.js";
import { createWorktree, type BranchStrategy } from "../../worktree.js";

/**
 * Worktree step: creates a git worktree per `WorktreeStep.strategy`, runs the
 * nested `body` steps with `${worktree.path}` and `${worktree.branch}` in
 * scope, then (for `merge-to-head`) merges the branch back into the host
 * repo's HEAD. Cleanup always runs in a finally — dirty worktrees are
 * preserved on disk and reported as `preservedPath`.
 */
export class WorktreeExecutor implements StepExecutor {
  type = "worktree" as const;

  async execute(step: WorkflowStepDef, ctx: StepContext): Promise<StepResult> {
    const s = step as WorktreeStep;
    const repoDir = s.repoDir ? String(resolveString(s.repoDir, ctx.scope)) : process.cwd();
    const branchOverride = s.branch ? String(resolveString(s.branch, ctx.scope)) : undefined;
    const worktreePath = s.worktreePath
      ? String(resolveString(s.worktreePath, ctx.scope))
      : undefined;

    const strategy: BranchStrategy =
      s.strategy === "head"
        ? { type: "head" }
        : s.strategy === "branch"
        ? { type: "branch", branch: branchOverride ?? defaultBranch(ctx) }
        : { type: "merge-to-head", branch: branchOverride };

    if (ctx.dryRun) {
      console.log(`[dry-run] worktree "${s.name}" skipped: ${s.strategy}`);
      return {
        output: {
          path: repoDir,
          branch: branchOverride ?? "dry-run-branch",
          merged: false,
          dryRun: true,
        },
      };
    }

    const wt = await createWorktree({ repoDir, strategy, worktreePath });
    let merged = false;
    let mergeError: string | undefined;
    let preservedPath: string | undefined;

    try {
      const childScope: Scope = {
        ...ctx.scope,
        vars: {
          ...(ctx.scope.vars ?? {}),
          worktree: { path: wt.path, branch: wt.branch, strategy: s.strategy },
        },
      };
      await ctx.engine.runStepList(s.body, childScope, ctx.signal, ctx.runId, ctx.stepId);

      if (s.strategy === "merge-to-head" && (s.mergeOnSuccess ?? true)) {
        if (typeof wt.mergeToHead !== "function") {
          throw new Error("merge-to-head strategy did not produce a mergeToHead() helper");
        }
        const result = await wt.mergeToHead();
        if (result.ok) {
          merged = true;
        } else {
          mergeError = result.reason;
          preservedPath = preservedPath ?? wt.path;
        }
      }
    } finally {
      try {
        const cleanup = await wt.cleanup();
        if (cleanup.preservedPath) preservedPath = cleanup.preservedPath;
      } catch (err) {
        console.warn(`[worktree] cleanup failed for ${wt.path}: ${(err as Error).message}`);
      }
    }

    return {
      output: {
        path: wt.path,
        branch: wt.branch,
        strategy: s.strategy,
        merged,
        ...(mergeError ? { mergeError } : {}),
        ...(preservedPath ? { preservedPath } : {}),
      },
    };
  }
}

function defaultBranch(ctx: StepContext): string {
  return `agent/${ctx.runId.slice(-8)}`;
}
