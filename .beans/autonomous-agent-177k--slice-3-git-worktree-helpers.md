---
# autonomous-agent-177k
title: 'Slice 3: Git worktree helpers'
status: completed
type: epic
priority: normal
created_at: 2026-05-03T22:42:53Z
updated_at: 2026-05-03T23:01:37Z
parent: autonomous-agent-6p6y
blocked_by:
    - autonomous-agent-objy
---

Thin wrapper at packages/core/src/worktree.ts over git worktree add/remove. Three branch strategies: head, branch, merge-to-head. cleanup() preserves dirty worktrees; removes clean ones. Used by workflow runners, not a direct agent tool.

## Tasks

- [x] Create `packages/core/src/worktree.ts` exporting `createWorktree({repoDir, strategy, worktreePath?})` and discriminated union `BranchStrategy`
- [x] Implement `git worktree add` for branch + merge-to-head; head strategy returns repoDir + current branch with no-op cleanup
- [x] `cleanup()` returns `{preservedPath?}`; checks `git status --porcelain` and preserves the worktree on disk if non-empty, else `git worktree remove`
- [x] `mergeToHead()` runs `git merge --no-ff`; on conflict, runs `git merge --abort` (host repo left clean) and returns `{ok: false, branchPreserved}`
- [x] `autoStash(repoDir, label?)` returns `{stashed, pop()}`. Stashes only modified-tracked files (untracked deliberately excluded); pop verifies stash@{0} still matches the label before popping
- [x] 10 unit tests in `__tests__/worktree.test.ts` against a temp git repo (covers all 3 strategies + cleanup paths + autoStash). Required adding CLAUDE.md docs too.
- [x] Export from `packages/core/src/index.ts` (`createWorktree`, `autoStash`, `BranchStrategy`, `CreateWorktreeOptions`, `Worktree`)

## Summary of Changes

- New `packages/core/src/worktree.ts`: `createWorktree({repoDir, strategy})` returns a `Worktree` with `path`, `branch`, `cleanup()`, and (for merge-to-head) `mergeToHead()`.
- Branch strategies: `head` (in-place, no-op cleanup), `branch` (named branch under `.worktrees/`), `merge-to-head` (named branch + auto-merge via `git merge --no-ff`; abort + preserve on conflict).
- `autoStash(repoDir)` for safely stashing modified-tracked files around merges; deliberately excludes untracked so `.worktrees/` doesn't get swept up.
- 10 unit tests against a temp git repo. All 183 core tests pass. Full monorepo typechecks clean.
- CLAUDE.md gained a "Worktrees" section.

This module is infrastructure for the workflow runner (S5), not an agent tool. Agents don't call `createWorktree` — workflow steps do.
