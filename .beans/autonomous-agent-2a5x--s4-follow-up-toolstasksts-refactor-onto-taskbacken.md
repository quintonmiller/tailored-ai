---
# autonomous-agent-2a5x
title: 'S4 follow-up: tools/tasks.ts refactor onto TaskBackend'
status: completed
type: task
priority: high
created_at: 2026-05-03T22:54:30Z
updated_at: 2026-05-03T23:55:15Z
parent: autonomous-agent-qrlk
---

TasksTool and TaskQueryTool in packages/core/src/tools/tasks.ts still import from db/task-queries.ts directly. Refactor them to use the runtime's configured TaskBackend so external backends actually flow through agent tool calls. Surface the backend on AgentRuntime (e.g. runtime.getTaskBackend()). Keep tool behavior identical for the native backend.

## Summary of Changes

- `TasksTool` and `TaskQueryTool` constructors now take a `TaskBackend` (`TasksTool` retains an optional `db` for the `getDefaultProjectId` lookup).
- All tool methods became `async` and route through the backend instead of `db/task-queries.ts` directly.
- `AgentRuntime` gains `getTaskBackend()`, builds the backend in its constructor + `reload()`, and threads it into `createTools` via `CreateToolsOptions.taskBackend`.
- `AutopilotWorker` now reuses `runtime.getTaskBackend()` instead of constructing its own backend (single source of truth).
- `autopilot-worker` test fixtures updated to pass `new NativeTaskBackend(db)` to `TasksTool`.
- All 183 tests pass; full monorepo typechecks clean.

With this in place, configuring `tasks.backend = github` (once the github adapter lands) will route both the autopilot worker AND the agent's `tasks`/`task_query` tool calls through GitHub Issues. Before this change, only the autopilot was on the backend; agent tool calls always hit SQLite.
