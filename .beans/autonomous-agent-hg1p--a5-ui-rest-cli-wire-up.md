---
# autonomous-agent-hg1p
title: A5 — UI + REST + CLI wire-up
status: completed
type: task
priority: high
created_at: 2026-05-13T07:59:12Z
updated_at: 2026-05-13T07:59:12Z
parent: autonomous-agent-gvue
---

Wires the ExploratoryWorker into the running system end-to-end.

CLI (packages/cli/src/index.ts):
- ExploratoryWorker instantiated in runServer() alongside AutopilotWorker
- exploratory.start() at boot, exploratory.stop() in shutdown
- Passed through to createServer({ exploratory })

REST (under /api/exploratory):
- GET /agents — list each online agent's config + state merged
                  (paused_until, last_tick_at, current_interval_ms,
                   tokens_today, runs_today, cadence, budgets) plus
                  worker activity snapshot
- GET /runs?agent=&limit= — recent xrun rows, newest first
- GET /runs/:id — single xrun
- POST /agents/:name/pause   { hours?: number=4 }
- POST /agents/:name/resume
- POST /agents/:name/disable — flip state.enabled=false
- POST /agents/:name/run     — manual one-shot trigger (calls runAgent)

UI (Dashboard "Watchers" panel + api.ts):
- New WatchersPanel between Memory and HealthFooter
- One row per online agent: state badge (ok/noop/error/budget/paused/off),
  runs today, tokens today, current interval, last tick time, action
  buttons (Run now / Pause 4h / Resume)
- Polls /api/exploratory/agents every 15s; shows live "running" pill when
  the worker reports an active activity
- Empty-state copy when exploratory disabled or no agents online

Typecheck clean across all 5 packages. 887 core + 36 server tests pass.
