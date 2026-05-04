---
# autonomous-agent-6vw5
title: 'S5.2: Workflow loader and registry'
status: completed
type: task
priority: high
created_at: 2026-05-04T01:08:16Z
updated_at: 2026-05-04T03:05:20Z
parent: autonomous-agent-jgev
blocked_by:
    - autonomous-agent-5tyi
---

Read workflows/*.yaml on startup. Validate against the step schema. Expose runtime.getWorkflows() and runtime.registerWorkflow(def). Hot-reload via fs.watch (debounced 500ms), same pattern as config reload. Validate references (agent names, tool names) at load time and surface warnings via validateConfig.
