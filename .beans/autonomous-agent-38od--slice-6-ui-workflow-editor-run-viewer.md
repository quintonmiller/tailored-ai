---
# autonomous-agent-38od
title: 'Slice 6: UI workflow editor + run viewer'
status: todo
type: epic
priority: low
created_at: 2026-05-03T22:42:54Z
updated_at: 2026-05-03T22:43:58Z
parent: autonomous-agent-6p6y
blocked_by:
    - autonomous-agent-jgev
---

React UI: workflow editor (linear step list w/ type-specific forms, outputs YAML), run viewer (live SSE tail of in-flight runs, per-step logs/commits/status), sandbox+worktree status panel, task-backend selector in Config sidebar.

## Tasks

- [ ] `packages/ui/src/pages/Workflows.tsx` — list + create + edit workflows; outputs YAML to `workflows/`
- [ ] Editor is a linear step list; type-specific forms per step (agent_run, tool_call, shell, condition, loop, parallel)
- [ ] `packages/ui/src/pages/WorkflowRuns.tsx` — list runs, click for detail w/ live SSE per-step log tail
- [ ] Sandbox + worktree status panel (active sandboxes, kill button)
- [ ] Task-backend selector in `ConfigSidebar.tsx`
- [ ] Server endpoints to support all of the above
