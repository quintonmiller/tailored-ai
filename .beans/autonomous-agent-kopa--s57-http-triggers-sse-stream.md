---
# autonomous-agent-kopa
title: 'S5.7: HTTP triggers + SSE stream'
status: completed
type: task
priority: normal
created_at: 2026-05-04T01:08:17Z
updated_at: 2026-05-04T03:21:26Z
parent: autonomous-agent-jgev
blocked_by:
    - autonomous-agent-sj5u
---

POST /api/workflows/:name/run accepts JSON body, returns { run_id }. GET /api/workflows lists registered workflows. GET /api/workflow-runs/:id returns run + steps. SSE on /api/workflow-runs/:id/events streams step transitions.
