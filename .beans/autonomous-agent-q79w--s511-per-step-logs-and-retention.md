---
# autonomous-agent-q79w
title: 'S5.11: Per-step logs and retention'
status: todo
type: task
priority: low
created_at: 2026-05-04T01:08:18Z
updated_at: 2026-05-04T01:08:30Z
parent: autonomous-agent-jgev
blocked_by:
    - autonomous-agent-sj5u
---

shell stdout/stderr and agent_run transcripts written to data/workflow-runs/<run-id>/<step>.log. Retention sweep keeps the last 100 runs per workflow on disk; older logs purge but DB rows persist.
