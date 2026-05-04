---
# autonomous-agent-4y7f
title: 'S7.8: Back-compat, docs, integration tests'
status: completed
type: task
priority: normal
created_at: 2026-05-04T06:21:00Z
updated_at: 2026-05-04T07:06:07Z
parent: autonomous-agent-bv73
---

Implemented:

**Docs (`CLAUDE.md`):** New "Projects (per-project mode)" section covering CLI commands, `.tai.yaml` shape, resolution logic (cwd walk-up + ancestor lookup), overlay merge semantics, what's project-scoped (sessions/loop cwd/cron/autopilot/Discord/HTTP/UI), CLI flags (`--project`, `--global`), and the explicit "going to all-projects-in-parallel later" path.

**Integration tests** (`project-integration.test.ts`, 5 cases):
- Full registration → resolve flow with two projects: one with `.tai.yaml` + overlay, one in lazy ancestor mode
- `setActiveProject` switches scope cleanly; sessions in project A and B are isolated by `project_id`
- Legacy DB upgrade preserves existing rows while adding all new columns (`projects.path`, `projects.config_overlay_path`, `sessions.project_id`, `cron_jobs.project_id`)
- Pure global mode (no `.tai.yaml`, no flags) — runtime activeProject null, sessions un-scoped, cron jobs without `project:` write null `project_id`
- Overlay-driven per-project task backend selection: project A's overlay sets `tasks.backend: github`, project B keeps `native`; the merged config exposes both correctly without mutating base

**Final end-to-end smoke** against the built CLI in a temp home dir: init writes the file + DB row, lazy `add` works, `list` marks the cwd's project, `show` displays overlay keys when present, `--list-sessions --global` filters correctly. Confirmed live.

Slice 7 wrap-up:
- 8 sub-beans, all completed
- Schema: 4 new columns (`projects.path`, `projects.config_overlay_path`, `sessions.project_id`, `cron_jobs.project_id`) + safe migrations + indexes
- New module: `packages/core/src/projects/resolve.ts` (walk-up discovery, ProjectContext type, file builder/parser)
- New CLI subcommand: `tai project {init,list,show,add,remove,help}`
- Runtime: `mergeProjectOverlay`, `setActiveProject`, per-call `buildLoopOptions({project})` override
- Server: `?project=` filter on `/api/sessions`, `path`/`config_overlay_path` on POST/PATCH `/api/projects`
- UI: `ProjectSwitcher` header dropdown + `useActiveProject` hook
- Discord: `channels.discord.projectMappings`
- Cron: `CronJobConfig.project: <id>` binding
- Autopilot: tasks scope to their project's path via `task.project_id`

435 tests passing (was 402 before S7), full repo typecheck clean. Documented limitations (multi-backend autopilot iteration, project-scoped workflow cwd, overlay-defined cron jobs only fire when project is active) all surface as explicit notes for future beans rather than silent gaps.

Closing the epic.
