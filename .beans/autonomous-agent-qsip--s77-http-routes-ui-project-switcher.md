---
# autonomous-agent-qsip
title: 'S7.7: HTTP routes + UI project switcher'
status: todo
type: task
priority: normal
created_at: 2026-05-04T06:21:00Z
updated_at: 2026-05-04T06:21:00Z
parent: autonomous-agent-bv73
---

## Goal
HTTP routes for project CRUD, plus a UI project switcher that filters the existing views.

## HTTP routes (`packages/server/src/routes/projects.ts`)
- `GET /api/projects` — list (existing `queryProjects`)
- `POST /api/projects` — create + write `.tai.yaml` if `path` provided
- `GET /api/projects/:id` — fetch one
- `PATCH /api/projects/:id` — update name/status
- `DELETE /api/projects/:id` — soft-delete (status=archived)
- `GET /api/projects/active` + `POST /api/projects/active` — UI's notion of currently-selected project (stored in a `ui_state` row, not real runtime state)

## UI (`packages/ui/`)
- Header dropdown: "All projects ▾ / proj_abc / proj_xyz"
- Persists selection in localStorage + posts to `/api/projects/active`
- Sessions sidebar, Kanban tasks board, cron list, workflow runs all filter by selected project (existing routes accept `?project=<id>` filter)
- "Projects" admin page for register/rename/archive

## Server-side filter plumbing
- Each list endpoint (`/api/sessions`, `/api/project-tasks`, `/api/cron-jobs`, `/api/workflow-runs`) accepts `?project=<id>` and `?project=global` (no project)

## Tests
- Routes: smoke + filter behavior
- UI: switcher persists, filters propagate (component test)
