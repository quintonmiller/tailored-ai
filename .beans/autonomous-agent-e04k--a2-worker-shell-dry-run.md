---
# autonomous-agent-e04k
title: A2 — worker shell (dry-run)
status: completed
type: task
priority: high
created_at: 2026-05-13T07:47:14Z
updated_at: 2026-05-13T07:47:14Z
parent: autonomous-agent-gvue
---

ExploratoryWorker class with start/stop/tick — but does NOT yet run the
agent loop. For each agent with online.enabled, evaluates:

- agent's online.enabled flag
- state.enabled in DB (UI/admin-driven kill switch)
- paused_until > now
- inside cadence.window (HH:MM, supports midnight crossover)
- runs_today < stop_after_runs_per_day cap
- now - last_tick_at >= effectiveInterval (honors current_interval_ms backoff)

Dispatches via onWouldRun callback + stamps last_tick_at so the worker
doesn't re-evaluate the same agent every base tick. Skip reasons surface
via onSkip for tests.

Injectable now() clock for testability. start() refuses if
exploratory.enabled is false. start/stop are idempotent.

Tests: 16 covering evaluate() decision tree + tick() integration + lifecycle.
Exported from @agent/core.

A3 wires the actual agent loop in.
