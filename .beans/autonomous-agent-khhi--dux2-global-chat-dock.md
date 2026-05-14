---
# autonomous-agent-khhi
title: DUX2 — Global chat dock
status: todo
type: task
priority: high
created_at: 2026-05-14T05:30:54Z
updated_at: 2026-05-14T05:30:54Z
parent: autonomous-agent-p0ae
---

# DUX2 — Global chat dock

Fixes pain point #5 (chat lives only on /chat) and surfaces approvals
(buried-approval friction).

## What's wrong today

- `Chat.tsx` is a full-page route at `#/chat`; navigating away loses chat
  context entirely.
- `ApprovalPanel` is rendered only inside `Chat.tsx`, so an agent waiting
  for approval is invisible if the user isn't on that page.
- Many `.catch(() => {})` silent failures across `api.ts` callsites.

## Changes

### App shell
- `packages/ui/src/App.tsx`: mount `<ChatDock>` alongside the router so it
  persists across navigation. The existing `/chat` route becomes the
  expanded view.
- New `packages/ui/src/components/ChatDock.tsx`: collapsible bottom-right
  panel (mini transcript + composer). Same SSE plumbing as `Chat.tsx`.

### State
- New `packages/ui/src/components/ChatContext.tsx`: lift `sessionId`,
  `agent`, `messages`, `stream` into context so dock and page share state.
- Refactor `Chat.tsx` to consume the context instead of owning state.

### Approvals
- Move the approval surface into the dock so it pops up no matter what
  page the user is on. A small badge on the dock header counts pending
  approvals; clicking opens the panel.

### Errors / toast
- New `packages/ui/src/components/Toast.tsx` (provider + `useToast()`).
- Replace `.catch(() => {})` in `Chat.tsx`, `Agents.tsx`, `Memory.tsx`
  with `useToast().error(err)` so users see what's failing.

### Keyboard / a11y
- `Cmd/Ctrl-K` toggles dock; `Esc` collapses.
- Focus management: composer focus on open; arrow keys navigate session
  list when sidebar is focused.
- ARIA labels on the dock, session sidebar, and approval panel.

## Acceptance

- Send a message from `/chat`, navigate to `#/tasks`, dock shows the
  ongoing stream. Send a follow-up from the dock; same session.
- Trigger an approval from a tool call — the dock badge counts it and the
  approval panel opens from any page.
- Network failures show a toast instead of silently doing nothing.
- `pnpm run typecheck` + `pnpm run test` pass.
