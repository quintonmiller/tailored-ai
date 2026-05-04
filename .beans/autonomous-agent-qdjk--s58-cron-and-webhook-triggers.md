---
# autonomous-agent-qdjk
title: 'S5.8: Cron and webhook triggers'
status: todo
type: task
priority: normal
created_at: 2026-05-04T01:08:17Z
updated_at: 2026-05-04T01:08:30Z
parent: autonomous-agent-jgev
blocked_by:
    - autonomous-agent-sj5u
---

Add 'workflow:' field on cron.jobs[] and webhooks.routes[] as a peer to 'agent:'. Existing 'agent:' configs keep working. Validation flags configs that set both. Cron context (last_run, etc.) becomes the workflow input.
