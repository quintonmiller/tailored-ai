---
# autonomous-agent-cv2p
title: 'S4 follow-up: GitHub Issues task backend'
status: completed
type: task
priority: high
created_at: 2026-05-03T22:54:30Z
updated_at: 2026-05-03T23:59:01Z
parent: autonomous-agent-qrlk
---

Implement packages/core/src/tasks/github.ts. Decision: gh CLI shell-out vs @octokit/rest — start with octokit (typed; no system dependency). Status mapping: open ↔ backlog/in_progress/blocked (via labels), closed ↔ done. Autopilot helpers (claimBacklog, nextBacklogTask, unblockBudgetTasks) need a labeling convention since GH lacks a 'rank' field — use issue number as rank, and a 'budget-blocked' label for the unblock helper.

## Summary of Changes

- Added `@octokit/rest` to `@agent/core` dependencies.
- New `packages/core/src/tasks/github.ts`: `GitHubTaskBackend` implementing the full `TaskBackend` interface.
- Wiring: `createTaskBackend` factory dispatches to `GitHubTaskBackend` when `tasks.backend = github`. Requires `tasks.github.repo` ("owner/repo") and `tasks.github.token`.
- Mapping: id ↔ `gh-<number>` (also accepts `#42` and bare `42`); status ↔ `status:*` labels with `closed` ⇒ `done`; tags ↔ labels (excluding `status:*`/`reason:*`); rank ↔ issue.number; blocked_reason ↔ first `reason:*` label; assignee ↔ first GH assignee.
- Autopilot helpers: `nextBacklogTask` queries `status:backlog` issues per assignee. `claimBacklog` reads-then-updates labels (best-effort atomic; loses a race if both attempt the same issue, but the second one observes `status:in_progress` and bails). `unblockBudgetTasks` looks for `status:blocked` + `reason:budget` and swaps to `status:backlog`.
- 12 tests (`__tests__/github-task-backend.test.ts`) using a hand-rolled in-memory `FakeOctokit` stub. All 195 tests pass; full monorepo typechecks.
- CLAUDE.md "Task Backends" section updated.

## Known limitations

- Comment author attribution: GitHub uses the token user; the agent's `agentName` parameter is currently dropped. Possible follow-up: prepend `[agentName] ...` only when distinct from the token user.
- Status labels (`status:backlog` etc.) must exist on the repo. The first `update()` will create them implicitly, but warming them up by hand avoids a transient mismatch.
- `delete()` closes the issue with `state_reason: not_planned` rather than truly deleting (deletion requires admin).
