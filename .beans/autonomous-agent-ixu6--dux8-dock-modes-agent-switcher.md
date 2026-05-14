---
# autonomous-agent-ixu6
title: DUX8 — Dock modes + agent switcher
status: completed
type: task
priority: high
created_at: 2026-05-14T07:00:51Z
updated_at: 2026-05-14T07:08:15Z
parent: autonomous-agent-p0ae
---

# DUX8 — Dock modes + agent switcher

Follow-up to DUX2 (global dock). The dock today is a fixed bottom-right
panel; user wants three positioning modes and dock-level controls for
agent + new chat.

## Modes

1. **Floating** — draggable around the viewport. Persist position +
   size in localStorage. Min ~280×320.
2. **Docked-left / docked-right** — full viewport height, anchored to a
   side, takes N% of width with no overlap. Body class sets a CSS var
   that .app uses for padding so the rest of the dashboard reflows.
   Vertical resize handle on the inner edge.
3. **Fullscreen** — link to `#/chat` (the existing full page already
   consumes the shared ChatStore).

Mode persists in `localStorage["tai.chat.dock.mode"]`.

## Dock-level controls

- Agent picker dropdown bound to `store.selectedAgent`.
- "New chat" button calling `store.newChat()`.
- Mode-switcher buttons in header (float, left, right, full).

## Constraints

- Don't break the FAB-when-closed UX.
- Closed in docked mode = body class is dropped (content reclaims width).
- Drag handle only enabled in floating mode.
- Resize handle only enabled in docked modes.
