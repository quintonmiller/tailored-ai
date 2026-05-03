---
# autonomous-agent-jgev
title: 'Slice 5: Workflow system'
status: todo
type: epic
priority: normal
created_at: 2026-05-03T22:42:53Z
updated_at: 2026-05-03T22:43:57Z
parent: autonomous-agent-6p6y
blocked_by:
    - autonomous-agent-klz6
    - autonomous-agent-objy
    - autonomous-agent-177k
---

Programmatic + declarative workflow engine. Step types: agent_run, tool_call, shell, condition, loop, parallel. Per-step deadlines via AbortController. Run state in SQLite, SSE event stream. Triggers: CLI, cron, HTTP, webhook, run_workflow tool. Existing AutopilotWorker becomes a workflow consumer.

## Tasks

- [ ] Design doc: `docs/workflows.md` covering step types, deadlines, run state, triggers, output threading (`${prev}`, `${steps.<name>}`)
- [ ] DB schema: `workflow_runs` and `workflow_steps` tables in `db/schema.ts`
- [ ] Workflow loader: read `workflows/*.yaml`, validate, hot-reload via runtime
- [ ] Engine: `runWorkflow(name, input)` — sequential step execution, abort on deadline, error policies
- [ ] Step types: `agent_run`, `tool_call`, `shell`, `condition`, `loop`, `parallel`
- [ ] `agent_run` step uses `runAgentLoop` (not opaque subprocess) so TAI tools work
- [ ] Cron `workflow:` field alongside `agent:`
- [ ] HTTP: `POST /api/workflows/:name/run` + `GET /api/workflow-runs/:id` + SSE stream
- [ ] `run_workflow` agent tool for nesting
- [ ] AutopilotWorker invokes a configured workflow per task tag instead of direct `runAgentLoop` (opt-in)
- [ ] Programmatic `defineWorkflow({...})` API for TS users
- [ ] Per-step logs under `data/workflow-runs/<run-id>/<step>.log`
- [ ] Tests: linear flow, condition, loop, parallel, deadline abort
- [ ] Document in CLAUDE.md
