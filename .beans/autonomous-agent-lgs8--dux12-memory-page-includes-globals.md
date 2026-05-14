---
# autonomous-agent-lgs8
title: DUX12 — Memory page includes globals
status: completed
type: task
priority: high
created_at: 2026-05-14T08:08:10Z
updated_at: 2026-05-14T08:08:10Z
parent: autonomous-agent-p0ae
---

# DUX12 — Memory page should include globals when filtering by project

The user has 17 facts and 3 notes, all scoped to `project_id IS NULL`
(global). The Memory page filters strictly by the active project id,
so the stats and lists showed zero for any selected project.

Global preferences/facts are meant to apply across every project, so a
project view should see its own + globals — not just its own.

## Changes

Mirror the inheritance behavior already in `listPinnedNotes`:

- `NoteQuery.includeGlobal: boolean` — when true AND `project_id` is a
  specific id, returns notes WHERE project_id = ? OR project_id IS NULL.
- `FactQuery.includeGlobal: boolean` — same semantics for facts.
- `/api/memory/notes`, `/api/memory/stats`, `/api/facts` pass
  `includeGlobal: true` whenever the project filter is a specific id.

`?project=global` still means globals only. Omitting the filter still
means "no project filter" (everything) for notes, "globals only" for
facts (back-compat with existing /api/facts behavior).

No UI changes — Memory.tsx already passes the active project id.
