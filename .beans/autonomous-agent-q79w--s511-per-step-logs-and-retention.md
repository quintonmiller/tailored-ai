---
# autonomous-agent-q79w
title: 'S5.11: Per-step logs and retention'
status: completed
type: task
priority: low
created_at: 2026-05-04T01:08:18Z
updated_at: 2026-05-04T03:30:28Z
parent: autonomous-agent-jgev
blocked_by:
    - autonomous-agent-sj5u
---

shell stdout/stderr and agent_run transcripts written to data/workflow-runs/<run-id>/<step>.log. Retention sweep keeps the last 100 runs per workflow on disk; older logs purge but DB rows persist.



## Retention policy (resolved 2026-05-04)

Keep the last 100 runs per workflow on disk; older runs purge their .log files but keep their DB rows. Implement as a sweep that runs after each new run completes (cheap — just counts rows + unlinks files).
