---
# autonomous-agent-ln4a
title: A4 — outputs + idle backoff
status: completed
type: task
priority: high
created_at: 2026-05-13T07:54:46Z
updated_at: 2026-05-13T07:54:46Z
parent: autonomous-agent-gvue
---

ExploratoryWorker.runAgent() now detects what the agent created during
a tick and applies idle backoff on no-ops.

Output detection:
- Pre-run snapshot of `datetime('now')` as cutoff
- Post-run query selects notes WHERE agent=? AND created_at>=cutoff;
  facts/project_tasks by created_at>=cutoff (best-effort attribution)
- Stored on the xrun row as note_ids, fact_ids, task_ids JSON arrays

Status reclassification:
- Pre-A4: error/budget/ok only
- A4: ok runs that produced no outputs reclassify to "noop"
- error/budget stand as-is

Idle backoff (only applied to noop runs):
- current_interval_ms *= idle_backoff_multiplier (default 2.0)
- Capped at max_interval_minutes (default 240m)
- Compounds across consecutive noops (10m → 20m → 40m → ...)
- Resets to null (back to base) on first ok
- Untouched on error / budget statuses

9 new tests cover the matrix. 887 core tests pass; typecheck clean.

A5: REST endpoints + Dashboard "Watchers" panel + CLI wire-up.
