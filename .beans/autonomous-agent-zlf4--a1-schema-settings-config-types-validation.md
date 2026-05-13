---
# autonomous-agent-zlf4
title: A1 — schema + settings + config types + validation
status: completed
type: task
priority: high
created_at: 2026-05-13T07:44:39Z
updated_at: 2026-05-13T07:44:39Z
parent: autonomous-agent-gvue
---

First slice of the always-on / exploratory agents work.

Shipped:
- Schema: exploratory_state + exploratory_runs tables (idempotent DDL, CHECK constraints on status)
- Config: OnlineAgentConfig + top-level exploratory block in AgentConfig
- DB queries: ensure/get/list/update + maybeResetDailyCounters; create/get/list/complete runs (COALESCE-preserves)
- Validation: warns when online.enabled lacks "recall" in tools; checks tool subset, cadence bounds, HH:MM window
- 13 query tests + 7 validation tests; 852 core tests pass; full typecheck clean

Worker not yet implemented — A2 next.
