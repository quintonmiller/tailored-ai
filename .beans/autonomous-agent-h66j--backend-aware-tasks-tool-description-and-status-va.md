---
# autonomous-agent-h66j
title: Backend-aware tasks tool description and status validation
status: completed
type: task
priority: high
created_at: 2026-05-04T00:14:18Z
updated_at: 2026-05-04T00:16:26Z
parent: autonomous-agent-6p6y
---

TasksTool.description and parameters.status.description still hard-code the SQLite enum (backlog, in_progress, blocked, in_review, done, archived). With the github backend in play, agents now see misleading guidance — github accepts in_review but doesn't have an archived state, and other backends will differ.

Make the tool's status enum derive from the backend at construction time: list `backend.statuses` plus any backend-declared extras. Bonus: validate the requested status before sending to the backend, returning a friendly error listing the valid values for the active backend.

## Summary of Changes

- `TaskBackend` interface gains optional readonly `extraStatuses` for backend-specific status values beyond the four normalized ones in `statuses`. NativeTaskBackend declares `['in_review', 'archived']`; GitHubTaskBackend declares `['in_review']`.
- `TasksTool` now derives `description` and `parameters` from the backend at construction time. The status field gets a JSON-Schema `enum` listing the backend's full set, and the description identifies the active backend.
- `create` and `update` validate the requested `status` against the active backend's full enum BEFORE doing any work, returning a friendly error listing valid values for that backend.
- 5 new tests in `__tests__/tasks-tool-status.test.ts` covering the description shape per backend and validation behavior.
- All 200 tests pass; full monorepo typechecks clean.

This means an agent talking to TAI configured with the github backend now sees an accurate status enum (`backlog/in_progress/blocked/done/in_review`, no `archived`), and an invalid choice produces a clear error rather than silently routing to a label that doesn't exist on the repo.
