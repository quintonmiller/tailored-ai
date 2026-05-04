---
# autonomous-agent-u7o3
title: 'S5.12: Workflow integration tests'
status: todo
type: task
priority: normal
created_at: 2026-05-04T01:08:18Z
updated_at: 2026-05-04T01:08:30Z
parent: autonomous-agent-jgev
blocked_by:
    - autonomous-agent-lt8e
---

End-to-end tests covering: linear agent_run flow, condition branching (then/else), loop sequential + parallel, parallel join, deadline abort, retry policy, restart resumes from last completed step. Use mocked providers/runners — no real external calls.
