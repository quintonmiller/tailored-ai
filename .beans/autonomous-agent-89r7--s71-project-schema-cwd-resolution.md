---
# autonomous-agent-89r7
title: 'S7.1: Project schema + cwd resolution'
status: completed
type: task
priority: normal
created_at: 2026-05-04T06:21:00Z
updated_at: 2026-05-04T06:24:12Z
parent: autonomous-agent-bv73
---

Implemented:
- `projects.path` + `projects.config_overlay_path` columns + safe migration for legacy DBs
- Unique non-null index on `path` (one repo = one row, NULL paths allowed for legacy/internal projects)
- `getProjectByPath()` query helper
- `createProject` accepts optional `id` so the DB row id can match the id baked into `.tai.yaml`
- New module `packages/core/src/projects/resolve.ts` — `findProjectFile`, `readProjectFile`, `buildProjectFile`, `resolveProjectFromCwd`, `ProjectContext` type, `PROJECT_FILE` constant
- Walk-up discovery from cwd; lazy fallback to ancestor-path lookup so `tai project add <path>` works without writing `.tai.yaml`
- Disk wins over DB on path mismatch (with warning) so a moved/copied repo still finds itself
- Tests: schema migration (new + legacy upgrade + unique constraint), file finder, file parser, full resolver flow incl. overlay loading, missing id, ancestor fallback

12 new tests, all green. Full repo typecheck + test suite passes.

Next: S7.2 (`tai project` CLI commands) consumes these primitives.
