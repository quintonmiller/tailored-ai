---
# autonomous-agent-4y7f
title: 'S7.8: Back-compat, docs, integration tests'
status: todo
type: task
priority: normal
created_at: 2026-05-04T06:21:00Z
updated_at: 2026-05-04T06:21:00Z
parent: autonomous-agent-bv73
---

## Goal
Back-compat hardening, docs, and integration tests covering the full per-project flow end-to-end.

## Back-compat
- No `.tai.yaml` anywhere → behavior identical to today (global mode, all sessions/tasks/cron unscoped)
- Existing global sessions/tasks/cron still load and run unchanged
- `--global` flag forces no-project mode inside a registered repo
- Migration script (or runtime auto-migration) adds new columns idempotently — verified on a real upgrade

## Docs
- New section in `CLAUDE.md`: "Projects (per-project mode)" — when to use, `.tai.yaml` schema, overlay semantics, gotchas
- Update "Adding a New Channel" / "Adding a Cron Job" sections to mention project scoping
- Update README front matter

## Integration tests
- E2E: init two projects, register both, run cron in each, verify isolation
- E2E: Discord message in mapped channel → routes to correct project session
- E2E: Autopilot with mixed task backends across projects
- Regression: legacy DB (no project columns) upgrades cleanly + existing sessions still resume

## Cleanup
- Delete any TODOs left across S7.1–S7.7
- Address all `[project:*] Warning:` cases surfaced during testing
