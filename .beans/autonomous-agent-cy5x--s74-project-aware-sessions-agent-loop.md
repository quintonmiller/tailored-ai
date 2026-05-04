---
# autonomous-agent-cy5x
title: 'S7.4: Project-aware sessions + agent loop'
status: todo
type: task
priority: normal
created_at: 2026-05-04T06:21:00Z
updated_at: 2026-05-04T06:21:00Z
parent: autonomous-agent-bv73
---

## Goal
Make agent runs project-aware: sessions carry `project_id`, agent loop cwd defaults to the project's path, tool execution scopes to project.

## Schema
- Add `project_id TEXT REFERENCES projects(id)` to `sessions` table (nullable for back-compat with global sessions)
- Index on `(project_id, updated_at)` for the UI sidebar

## Session lifecycle
- `findOrCreateSession(db, key, model, provider, projectId?)` writes project_id on create
- CLI: when active project resolved from cwd, sessions are keyed `project:<id>:<channel>:<user>` instead of bare key — keeps global and per-project chats separate
- Resume by key respects project scope (no cross-project session bleed)

## Agent loop
- `AgentLoopOptions.cwd` defaults to active project's path when present, else `process.cwd()`
- Tool exec/read/write paths default to that cwd (already the case via sandbox layer; just verify)

## CLI
- `--project <id>` flag overrides cwd-based resolution
- `--list-sessions` accepts `--project <id>` filter
- New `--global` flag forces no-project mode even inside a registered repo

## Tests
- Session created in project A, resumed from project B → not found
- Same channel+user keyed differently across projects
- `--project` flag overrides cwd
