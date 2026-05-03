---
# autonomous-agent-qrlk
title: 'Slice 4: Pluggable task backends'
status: completed
type: epic
priority: high
created_at: 2026-05-03T22:42:53Z
updated_at: 2026-05-03T22:54:31Z
parent: autonomous-agent-6p6y
---

TaskBackend interface decoupling autopilot from native SQLite. Adapters: native (existing), github (Issues), beans, beads. Refactor AutopilotWorker + tasks/task_query tools to route through configured backend. Status-mapping helper since enums differ across backends.

## Tasks

- [x] Create `packages/core/src/tasks/interface.ts` with `TaskBackend`, normalized `Task` shape, `TaskFilter`, `TaskStatusMap`, plus `Create/Update/QueryResult` shapes
- [x] Create `packages/core/src/tasks/native.ts` wrapping existing `db/task-queries.ts` (zero behavior change)
- [-] `packages/core/src/tasks/github.ts` — moved to follow-up bean autonomous-agent-cv2p
- [-] `packages/core/src/tasks/beans.ts` — moved to follow-up bean autonomous-agent-xyp8
- [-] `packages/core/src/tasks/beads.ts` — moved to follow-up bean autonomous-agent-lyos
- [x] Add `tasks.backend` config + per-backend options (`github.repo/token`, `beans.path`, `beads.path`)
- [x] Refactor `AutopilotWorker` to take a `TaskBackend` (default = `createTaskBackend(config, db)`); status strings now go through `backend.statuses.*`. All 9 existing autopilot tests still pass.
- [-] tools/tasks.ts refactor — moved to follow-up bean autonomous-agent-2a5x
- [x] Status mapping per backend (`TaskStatusMap` + `isDone`); native maps to `backlog/in_progress/blocked/done` and treats `done` and `archived` as terminal
- [x] Unit tests for native (`__tests__/native-task-backend.test.ts`, 11 tests). External-backend tests deferred until those backends exist.
- [x] Export from `packages/core/src/index.ts` (`Task`, `TaskBackend`, `TaskFilter`, `TaskCreateInput`, `TaskUpdateInput`, `TaskStatusMap`, `createTaskBackend`, `NativeTaskBackend`)
- [x] Document task backends in CLAUDE.md (new "Task Backends" section)

## Follow-ups created

- autonomous-agent-2a5x — tools/tasks.ts refactor
- autonomous-agent-cv2p — GitHub Issues backend
- autonomous-agent-xyp8 — beans backend
- autonomous-agent-lyos — beads backend

## Summary of Changes

- New `packages/core/src/tasks/` module: `interface.ts` (TaskBackend, normalized Task, status map), `native.ts` (SQLite-backed, behavior-preserving), `factory.ts` (`createTaskBackend(config, db)`).
- New `tasks` config block on `AgentConfig` with `backend` selector and per-backend option slots for github/beans/beads. Default `tasks.backend = "native"`.
- `AutopilotWorker` refactored to use `TaskBackend`. All status string literals (`"in_progress"`, `"blocked"`, `"done"`) replaced with `this.tasks.statuses.*`. Constructor accepts an optional `taskBackend` override; otherwise builds from runtime config.
- `buildTaskPrompt` now takes the normalized `Task` shape; comments handled via `task.comments ?? []`.
- 11 unit tests in `__tests__/native-task-backend.test.ts`. All 164 core tests pass; full monorepo typechecks clean.
- CLAUDE.md gained a "Task Backends" section.
- Four follow-up beans cover the remaining work (tools/tasks.ts refactor, github/beans/beads adapters).
