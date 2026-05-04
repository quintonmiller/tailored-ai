---
# autonomous-agent-hc1o
title: 'S7.5: Cron + autopilot per-project'
status: todo
type: task
priority: normal
created_at: 2026-05-04T06:21:00Z
updated_at: 2026-05-04T06:21:00Z
parent: autonomous-agent-bv73
---

## Goal
Cron jobs and the autopilot worker become project-aware. One scheduler, one worker, but every job/task carries a project context.

## Cron
- Add `project: <id>` field to `CronJobConfig`
- `CronScheduler` resolves the project on each fire, sets `cwd` to project path, threads `projectId` into the agent loop
- Per-project cron jobs can live in either: (a) global `config.yaml` with explicit `project:`, or (b) a project's `.tai.yaml` overlay (no `project:` needed — implicit)
- Job state in `cron_jobs` DB table gains `project_id` column

## Autopilot
- `AutopilotWorker` iterates `queryProjects({status: 'active'})` on each tick instead of a single global queue
- For each project: claim one backlog task via that project's task backend (which may be configured per-project via overlay), run with `cwd = project.path` and `projectId = project.id`
- Round-robin across projects to avoid one repo starving others
- Empty backlog on a project = skip; all empty = sleep tick

## Per-project task backend
- The merged config's `tasks.backend` reflects the active project's choice
- When iterating projects, autopilot constructs the backend per-project (cached by project_id)

## Tests
- Cron job in project A overlay fires with project A's cwd
- Autopilot with two projects round-robins task claims
- Project A uses GitHub backend, project B uses native — both serviced from one worker tick
