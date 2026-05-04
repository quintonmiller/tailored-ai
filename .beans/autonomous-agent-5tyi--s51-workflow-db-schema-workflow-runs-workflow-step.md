---
# autonomous-agent-5tyi
title: 'S5.1: Workflow DB schema (workflow_runs + workflow_steps)'
status: completed
type: task
priority: high
created_at: 2026-05-04T01:08:16Z
updated_at: 2026-05-04T03:02:03Z
parent: autonomous-agent-jgev
---

Add workflow_runs and workflow_steps tables to db/schema.ts as designed in docs/workflows.md. Add basic query helpers (createRun, updateRunStatus, recordStep, listSteps). Tests for table creation and CRUD round-trip.
