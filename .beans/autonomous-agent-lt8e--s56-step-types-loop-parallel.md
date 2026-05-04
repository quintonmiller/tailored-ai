---
# autonomous-agent-lt8e
title: 'S5.6: Step types — loop + parallel'
status: todo
type: task
priority: normal
created_at: 2026-05-04T01:08:17Z
updated_at: 2026-05-04T01:08:29Z
parent: autonomous-agent-jgev
blocked_by:
    - autonomous-agent-sj5u
---

loop iterates over an array (sequential by default; parallel: true with maxConcurrency). parallel runs a named-step group concurrently and joins. Both record child steps in workflow_steps with parent_step_id. Output shapes: loop → array, parallel → object.
