---
"@tailored-ai/core": patch
"@tailored-ai/cli": patch
---

Task-watcher routes notifyById through the per-project backend resolver
(PR #123). Previously the watcher's notifyById always looked up tasks
via direct SQL against `project_tasks` — fine for native-backend tasks
but invisible to GitHub-issue tasks (`gh-*` ids), which silently
dropped out of the routing pipeline. The coder agent never ran on any
task filed via the per-project GH backend.

- `TasksToolNotify` callback signature gains an optional `projectId`
  argument. The tasks tool passes the calling args' `project_id` on
  every create/update/comment.
- The CLI's `_taskWatcherRef.notifyById` accepts the new arg and
  forwards to the watcher.
- `TaskWatcher.notifyById` uses `runtime.getTaskBackendForProject(projectId).get(id)`
  when `projectId` is supplied; the native SQL path is preserved as
  fallback for the no-projectId case.
- Project id is injected back onto the resolved task so downstream
  worktree-path resolution finds the right repo.

Three new tests cover the project-routed path, the native-fallback
path, and the gracefully-empty case.
