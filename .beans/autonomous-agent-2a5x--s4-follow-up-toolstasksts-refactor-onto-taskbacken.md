---
# autonomous-agent-2a5x
title: 'S4 follow-up: tools/tasks.ts refactor onto TaskBackend'
status: todo
type: task
priority: normal
created_at: 2026-05-03T22:54:30Z
updated_at: 2026-05-03T22:54:30Z
parent: autonomous-agent-qrlk
---

TasksTool and TaskQueryTool in packages/core/src/tools/tasks.ts still import from db/task-queries.ts directly. Refactor them to use the runtime's configured TaskBackend so external backends actually flow through agent tool calls. Surface the backend on AgentRuntime (e.g. runtime.getTaskBackend()). Keep tool behavior identical for the native backend.
