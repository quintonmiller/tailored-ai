---
# autonomous-agent-w48s
title: DUX1 — Session persistence & continuity
status: completed
type: task
priority: high
created_at: 2026-05-14T05:30:46Z
updated_at: 2026-05-14T05:37:21Z
parent: autonomous-agent-p0ae
---

# DUX1 — Session persistence & continuity

Fixes pain point #1 (no long-lasting conversations) and seeds #5 (global chat).

## What's wrong today

- `packages/ui/src/pages/Chat.tsx` mints `web:${Date.now()}` for the session
  key on each visit, never restoring a prior one.
- `sessions.slice(0, 30)` hard-cap in the sidebar with no search/pagination.
- No way to name or pin a conversation.

## Changes

### Schema
- `packages/core/src/db/schema.ts`: add columns
  `sessions.title TEXT` and `sessions.pinned INTEGER DEFAULT 0`. Idempotent
  `ALTER TABLE … ADD COLUMN` so existing DBs upgrade cleanly.

### Core
- `packages/core/src/db/session-queries.ts` (or wherever `findOrCreateSession`
  lives): add `updateSessionMeta(db, id, { title?, pinned? })` and surface
  the new columns on `SessionRow`.

### Server
- `packages/server/src/index.ts`: add `PATCH /api/sessions/:id` accepting
  `{ title?: string, pinned?: boolean }`, returning the updated row.
- Existing `GET /api/sessions` should already include the new columns once
  they're on `SessionRow`; double-check the SELECT and projection.

### UI
- `packages/ui/src/api.ts`: add `updateSession(id, patch)` typed helper.
- `packages/ui/src/pages/Chat.tsx`:
  - Restore `localStorage["tai.chat.activeSessionId"]` on mount; save when
    user clicks a session or one is created.
  - "Pin" toggle and inline rename on each sidebar entry.
  - Group sidebar as: Pinned · Recent. Drop the `slice(0, 30)`; add a
    search box that filters by title or message preview.

## Acceptance

- Visiting `/chat`, sending a message, navigating away, and returning lands
  back in the same session.
- Sessions can be renamed and pinned; pinned ones float to the top and
  survive `--list-sessions` truncation.
- `pnpm run typecheck` + `pnpm run test` pass.
