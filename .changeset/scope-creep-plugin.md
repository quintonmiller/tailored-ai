---
"@tailored-ai/core": patch
"@tailored-ai/cli": patch
---

Extract scope-creep flagging out of TaskWatcher into a
`ScopeCreepFlagger` default plugin — Slice 3 step 2 of the platform
vision (`docs/platform-vision.md`). The plugin subscribes to
`agent.completed` and, when the coder hands off a worktree branch to
the reviewer, scans the branch's commits for foreign `ptask_*` ids
and writes a SCOPE WARNING comment when it finds any.

**Bug fix**: the watcher's inline implementation ran git inside
`worktree.path`, which is gone by the time the check runs on a clean
coder→reviewer handoff (worktree.cleanup() removes the dir before the
scope-creep block executes). The plugin now runs git in the parent
repo and references the branch by name, so it works in both the
preserved and cleaned-up cases. `detectScopeCreep`'s signature changes
from `(worktreePath, expectedTaskId)` to
`({ repoPath, branch, expectedTaskId })` to reflect this.

- New `agent.completed` payload field: `worktree?: { repoPath,
  worktreePath, branch, preservedPath }`. The watcher captures
  `worktreeRepoPath` at creation time so it can attach the parent-repo
  path to the event even after cleanup.
- New `packages/core/src/plugins/scope-creep.ts` with
  `ScopeCreepFlagger` and a thin `writeScopeWarning` helper.
- Watcher drops the inline scope-creep block (~26 LOC) and the
  unconditional `addTaskComment` import path that fed it.
- CLI constructs `new ScopeCreepFlagger({ runtime })` alongside
  `new DiscordNotifier(...)` and stops both on shutdown.

9 new tests cover the gate (3 cases that should be ignored), the
write path (2 cases including the parent-repo-not-worktree assertion),
git error handling, stop()/dispose, and the formatter shape.

Slice 3 step 3 (stall guard as a plugin, using a new
`task.dispatch_requested` event for re-fire) follows as a separate PR.
