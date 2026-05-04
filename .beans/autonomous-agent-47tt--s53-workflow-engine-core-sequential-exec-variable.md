---
# autonomous-agent-47tt
title: 'S5.3: Workflow engine core (sequential exec + variable threading)'
status: todo
type: task
priority: high
created_at: 2026-05-04T01:08:16Z
updated_at: 2026-05-04T01:08:29Z
parent: autonomous-agent-jgev
blocked_by:
    - autonomous-agent-6vw5
---

runWorkflow(name, input) executes steps sequentially. Threads input/steps/prev/env through expandPrompt. Records each step transition in workflow_steps before invoking. Honors per-step deadlineMs and onError policies (fail/continue/retry). No step types yet — pluggable executor registry.
