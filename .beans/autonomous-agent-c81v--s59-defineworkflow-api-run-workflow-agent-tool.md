---
# autonomous-agent-c81v
title: 'S5.9: defineWorkflow API + run_workflow agent tool'
status: completed
type: task
priority: normal
created_at: 2026-05-04T01:08:17Z
updated_at: 2026-05-04T03:26:26Z
parent: autonomous-agent-jgev
blocked_by:
    - autonomous-agent-sj5u
---

defineWorkflow({...}) is a typed identity helper. runtime.registerWorkflow(def) accepts programmatic registrations. run_workflow is an agent tool with args { name, input } that calls runtime.runWorkflow(); enables nested workflow composition from inside agent loops.
