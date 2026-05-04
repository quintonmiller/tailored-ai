---
# autonomous-agent-w9qg
title: 'S7.3: Per-project config overlay'
status: completed
type: task
priority: normal
created_at: 2026-05-04T06:21:00Z
updated_at: 2026-05-04T06:43:37Z
parent: autonomous-agent-bv73
---

Implemented:
- `mergeProjectOverlay(base, overlay)` in `packages/core/src/config.ts` — wraps existing `deepMerge` with the right types, returns base unchanged for empty overlays, leaves base un-mutated.
- Semantics: maps deep-merge (including `agents.<name>` so a project can override one field without redefining the whole agent), arrays replace wholesale.
- `AgentRuntime` carries an `_activeProject?: ProjectContext`. Constructor accepts `initialProject` and merges its overlay into the initial config + tools + provider.
- `getActiveProject()` / `setActiveProject(p | null)` accessors. `setActiveProject` triggers `reload()` so the new merged config takes effect across all subsystems holding a runtime ref.
- `reload()` re-merges the overlay on each call (so file-watcher reloads pick up the live overlay too) and emits validation warnings introduced by the overlay with a `[project:<id>] Warning:` prefix — diff'd against base validation so users only see overlay-specific issues.
- Reload log line now includes `[project:<id>]` when active.

Tests: 11 new (`project-overlay.test.ts`) covering merge semantics (empty/scalars/agents/arrays/no-mutation), constructor with initial project, `setActiveProject` switch + clear, validation prefix on reload. 412 total passing.

Next: S7.4 (thread project_id through sessions and the agent loop). Then the `tai` CLI startup needs a tiny addition to call `runtime.setActiveProject(resolveProjectFromCwd(...))` before launching server/single-message mode — that wiring lands in S7.4 alongside session changes.
