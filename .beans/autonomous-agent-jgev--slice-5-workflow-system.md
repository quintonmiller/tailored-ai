---
# autonomous-agent-jgev
title: 'Slice 5: Workflow system'
status: completed
type: epic
priority: normal
created_at: 2026-05-03T22:42:53Z
updated_at: 2026-05-04T03:32:10Z
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



## Design

See [docs/workflows.md](../docs/workflows.md) for the design doc covering step types, scope, error policies, restart semantics, storage, and triggers.

## Sub-beans (in execution order)

1. autonomous-agent-5tyi — S5.1: Workflow DB schema
2. autonomous-agent-6vw5 — S5.2: Workflow loader and registry
3. autonomous-agent-47tt — S5.3: Workflow engine core
4. autonomous-agent-sj5u — S5.4: Step types — agent_run + tool_call
5. autonomous-agent-nnju — S5.5: Step types — shell + condition
6. autonomous-agent-lt8e — S5.6: Step types — loop + parallel
7. autonomous-agent-kopa — S5.7: HTTP triggers + SSE stream
8. autonomous-agent-qdjk — S5.8: Cron and webhook triggers
9. autonomous-agent-c81v — S5.9: defineWorkflow + run_workflow tool
10. autonomous-agent-rndc — S5.10: Autopilot workflow integration
11. autonomous-agent-q79w — S5.11: Per-step logs and retention
12. autonomous-agent-u7o3 — S5.12: Workflow integration tests

Slices 1–4 are the critical path: after them you can already run a linear agent_run-only workflow from HTTP. Everything else is incremental.
