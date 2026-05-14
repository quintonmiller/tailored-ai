---
# autonomous-agent-o0ry
title: DUX6 — Proactivity (proposals)
status: completed
type: task
priority: normal
created_at: 2026-05-14T05:30:54Z
updated_at: 2026-05-14T06:00:17Z
parent: autonomous-agent-p0ae
---

# DUX6 — Proactivity (proposals)

Fixes pain point #8 (agents don't proactively identify problems / fix /
propose tasks).

## What's wrong today

- Agents are purely reactive in chat — they answer what's asked.
- They have tools to create tasks and notes, but no instruction or output
  convention that prompts them to look around and flag issues.

## Convention

Agents emit a `<proposal>` tag when they notice something out of scope:

```
<proposal kind="task" priority="normal" tags="docs,memory">
  <title>Document memory-inject SSE event shape</title>
  <body>
    The memory-inject path now emits an event but it's undocumented.
    Suggest adding a section to CLAUDE.md and a brief in docs/memory-tiers.md.
  </body>
</proposal>
```

`kind` is one of `task` (create a project task), `fix` (agent claims it
can fix and is asking permission), or `note` (record for later).

## Changes

### Agent behavior
- Default chat agents get a clause in their instructions:
  "If you notice a problem outside the current request, emit one
  `<proposal>` after your reply. Do not act on it without confirmation."
- Default model temperature stays low to keep this disciplined.

### UI rendering
- `MessageBubble.tsx`: detect `<proposal>` blocks, render as a card with
  "Accept" / "Dismiss" / "Tell me more" actions.
  - Accept on `kind="task"` → POST `/api/project-tasks` with the title/body/tags.
  - Accept on `kind="fix"` → send a follow-up message: "Please apply the fix you proposed."
  - Dismiss → send a recall note `dismissed-proposal: <title>` so the agent
    can learn not to re-propose.
- Accepted/dismissed proposals annotate the chat with a small status badge.

### Memory loop
- Dismissed proposals create a low-importance note tagged
  `dismissed-proposal`; memory injection will surface it next time a
  similar topic comes up so the agent backs off.

## Acceptance

- A chat that says "explain how memory injection works" produces an
  answer plus a `<proposal>` if the docs are stale.
- Accepting creates a task visible in `#/tasks`; dismissing writes a
  recall note visible in `#/memory`.
- `pnpm run typecheck` + `pnpm run test` pass.
