---
# autonomous-agent-cy5x
title: 'S7.4: Project-aware sessions + agent loop'
status: completed
type: task
priority: normal
created_at: 2026-05-04T06:21:00Z
updated_at: 2026-05-04T06:47:29Z
parent: autonomous-agent-bv73
---

Implemented:
- Schema: `sessions.project_id TEXT REFERENCES projects(id)` (nullable). Safe migration for legacy DBs. Index `(project_id, updated_at)` for the upcoming UI sidebar.
- `Session` interface gains `projectId?: string | null` (defaults to null = global).
- `newSession`, `findOrCreateSession`, `resetSession`, `loadSession`, `createSession` all accept/round-trip `projectId`. On resume, `findOrCreateSession` preserves the existing session's project_id so callers can't accidentally re-scope a returning conversation.
- `listSessions(db, { projectId, limit })` — accepts a project id, the literal "global" for un-scoped only, or undefined for all.
- `AgentLoopOptions.cwd?: string`. `runAgentLoop` uses `opts.cwd ?? process.cwd()`. `runtime.buildLoopOptions()` sets `cwd` to the active project's path so tool execution and sandbox.prepare both operate against the right files.
- CLI: `--project <id>` and `--global` flags. After runtime construction, the CLI resolves the project from cwd (unless overridden) and calls `runtime.setActiveProject(...)`. `--list-sessions` accepts the same flags for filtering and shows `[proj:<id>]` next to scoped sessions.

Tests: 6 new (`project-sessions.test.ts`) — round-trip, find-or-create resume preserves scope, list filtering by project / "global" / unfiltered, legacy DB upgrade column check. 418 total passing. CLI smoke test confirms `tai project init` + `tai --list-sessions` + flag visibility.

Note on session keys: callers (Discord channel, webhook routes, etc.) still own their own keying scheme. S7.6 will adjust the Discord channel key to include the project id so the same Discord user in different mapped channels gets isolated sessions. For now, sessions created by the CLI in single-message mode get an ephemeral random id (no key) and naturally isolate.

Next: S7.5 (cron + autopilot per-project).
