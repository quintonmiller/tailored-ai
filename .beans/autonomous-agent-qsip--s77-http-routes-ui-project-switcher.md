---
# autonomous-agent-qsip
title: 'S7.7: HTTP routes + UI project switcher'
status: completed
type: task
priority: normal
created_at: 2026-05-04T06:21:00Z
updated_at: 2026-05-04T07:03:24Z
parent: autonomous-agent-bv73
---

Implemented:

**Server:**
- `GET /api/sessions` accepts `?project=<id>` and `?project=global` filters (passes through to `listSessions` from S7.4)
- `POST /api/projects` and `PATCH /api/projects/:id` accept `path`, `config_overlay_path`, and (POST only) `id` so registration endpoints round-trip the new fields

**UI:**
- New `ProjectSwitcher` component in the header — dropdown populated from `/api/projects`, options "All projects" / "Global only" / each registered project. Selection persisted to `localStorage["tai.activeProjectId"]`. Hidden entirely when no projects are registered (no visual noise for global-mode users).
- New `useActiveProject()` hook that reads localStorage and re-renders on the `tai:active-project-change` custom event.
- `api.ts` exports `getActiveProjectId` / `setActiveProjectId`. `fetchSessions(opts?)` automatically appends `?project=` from the active selection unless an explicit override is passed.
- Dashboard and Chat sidebar re-fetch sessions when the switcher changes (added `activeProject` to their effect deps).
- Project type in `api.ts` extended with `path` + `config_overlay_path` so admin views can render them.

Out of scope (follow-ups):
- A dedicated "register a new project from the UI" flow — `tai project init` from the CLI does this fine for now. The existing `/api/projects` POST is enough for any future UI to use.
- Filtering for `/api/cron`, `/api/project-tasks`, `/api/workflow-runs`, `/api/agents` — none of these have project_id columns yet (cron does, the others don't). Threading project filtering through them is incremental and isn't blocking S7's value.
- A `GET /api/projects/active` server endpoint — UI state lives in localStorage; the server's runtime active-project is a separate concept (set per-process via cwd resolution) and shouldn't be controlled by UI clicks.

UI built successfully (374 kB / 103 kB gzip), full repo typecheck clean, all tests passing.

Next: S7.8 (back-compat, docs, integration tests).
