---
# autonomous-agent-hc1o
title: 'S7.5: Cron + autopilot per-project'
status: completed
type: task
priority: normal
created_at: 2026-05-04T06:21:00Z
updated_at: 2026-05-04T06:57:00Z
parent: autonomous-agent-bv73
---

Implemented:
- `CronJobConfig.project?: string` — explicit binding to a registered project. When set, the job runs with the project's path as cwd, the session is project-scoped, and the auto-derived session key includes the project id (`cron:<projectId>:<name>`) so the same job declared in multiple projects doesn't collide.
- `cron_jobs.project_id` column + safe migration. `upsertJobRow` writes it from `job.project`.
- Cron `resolveJobProject(job)` looks up the project by id; warns and falls back to global if unknown or path-less.
- `runtime.buildLoopOptions({ project: ctx | null })` — per-call project override that wins over the runtime's `_activeProject`. Used by cron and autopilot so a single runtime can serve multiple projects without flipping the global active-project state.
- Autopilot `resolveTaskProject(task)` reads `task.project_id` and resolves to a `ProjectContext` with the registered path. The agent loop runs in that path and the autopilot session is scoped to it.

Not in scope (documented as follow-up):
- Multi-backend autopilot iteration: the worker still uses the runtime's single task backend per tick. Cross-project iteration (project A on GitHub, project B on beads, all serviced by one tick) requires per-project config resolution and is its own bean.
- Workflow trigger paths (`engine.runWorkflow`) don't yet thread cwd. Project-scoped tasks tagged `workflow:<name>` will run in the host cwd until the engine grows a cwd parameter.
- Cron jobs declared in a project's `.tai.yaml` overlay only fire when that project is the active runtime project (single-tenant constraint of S7).

Tests: 6 new (`project-cron-autopilot.test.ts`) — `upsertJobRow` writes project_id + scoped session key, leaves global jobs untouched, `resolveJobProject` warns on unknown ids and resolves valid ones, `buildLoopOptions({project})` overrides runtime's active project, `project: null` clears cwd. 424 total passing.

Next: S7.6 (Discord channel→project mapping).
