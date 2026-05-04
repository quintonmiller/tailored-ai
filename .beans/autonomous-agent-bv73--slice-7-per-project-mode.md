---
# autonomous-agent-bv73
title: 'Slice 7: Per-project mode'
status: todo
type: epic
priority: normal
created_at: 2026-05-04T06:19:38Z
updated_at: 2026-05-04T06:19:38Z
---

TAI today is a global, single-tenant tool: one home dir (`~/.tailored-ai/` or `TAI_HOME`), one config, one DB, one Discord bot, one cron scheduler, one autopilot worker. This slice lets a single TAI brain manage N registered repos by threading `project_id` through sessions, tasks, cron, autopilot, and channels — without forking the install or going multi-process.

Mental model: `tai project init` from a repo drops a `.tai.yaml` and registers the repo in the existing `projects` table. `tai` commands resolve "which project am I in?" by walking up from cwd. Sessions/tasks/cron/autopilot scope to that project. The UI grows a project switcher. One Discord bot serves all projects via channel→project mappings.

Why this shape (not a workspace daemon): runs are still serial (one agent loop at a time), no IPC or supervision, builds on the existing `projects` table. The `project_id` threading done here is also the prerequisite for ever upgrading to a daemon model later — so it's not a dead end.

## Tasks

[ ] Schema + project resolution from cwd, `.tai.yaml` discovery, `ProjectContext` type
[ ] `tai project` CLI commands (init, list, add, remove, show, switch)
[ ] Per-project config overlay merged over global config in `runtime.reload()`
[ ] Thread `project_id` through sessions, agent loop cwd, tool allowlist scope
[ ] Cron per-project: `project:` field on jobs; scheduler runs in project cwd
[ ] Autopilot per-project: worker iterates registered projects, claims backlog from each
[ ] Discord channel→project mapping; session keys include project
[ ] HTTP API + UI project switcher in header (filters sessions/tasks/runs)
[ ] Migration + CLAUDE.md + integration tests

## Non-goals

- Multi-process daemon / true cross-project parallelism (that's the future Slice 8)
- Per-project Discord bots — one bot, channel routing only
- Per-project provider config (global only) — could be added later if needed

## Sub-beans (execution order)

Created as separate beans, see children.
