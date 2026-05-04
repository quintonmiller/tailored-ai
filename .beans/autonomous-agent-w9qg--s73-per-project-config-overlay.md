---
# autonomous-agent-w9qg
title: 'S7.3: Per-project config overlay'
status: todo
type: task
priority: normal
created_at: 2026-05-04T06:21:00Z
updated_at: 2026-05-04T06:21:00Z
parent: autonomous-agent-bv73
---

## Goal
Per-project config overlay: `.tai.yaml`'s `config:` block merges over the global `config.yaml`, so a project can extend agents, override tools, define its own task backend, etc.

## Merge semantics

Deep merge with project-wins precedence:
- Top-level keys merged (`agent`, `agents`, `tools`, `tasks`, etc.)
- Maps: project keys override global keys at the same path; new keys added
- Arrays: replace, not concat (least surprising default; documented)
- `agents.<name>` maps deep-merge so a project can override one field of an agent without redefining it

## Wiring

- `AgentRuntime` gains optional `activeProject?: ProjectContext`
- `runtime.reload()` re-reads global config, reads overlay if active project, deep-merges, builds tools/provider
- `runtime.setActiveProject(project | null)` triggers a reload
- New helper `mergeConfig(base, overlay): AgentConfig` in `packages/core/src/config.ts` with explicit semantics

## Validation
`validateConfig` runs against the merged config. Project overlays that introduce dangling tool refs surface as warnings prefixed `[project:<id>] Warning: ...`.

## Tests
- Merge unit tests covering each top-level section
- Overlay adds new agent → resolveAgent finds it
- Overlay overrides tool config → tool factory picks up the override
- No overlay → identical to no-project behavior
