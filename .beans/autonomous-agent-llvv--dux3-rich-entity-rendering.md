---
# autonomous-agent-llvv
title: DUX3 — Rich entity rendering
status: todo
type: task
priority: normal
created_at: 2026-05-14T05:30:54Z
updated_at: 2026-05-14T05:30:54Z
parent: autonomous-agent-p0ae
---

# DUX3 — Rich entity rendering

Fixes pain point #6 (no rich entity rendering) and #3 (no delegate viz).

## What's wrong today

- `packages/ui/src/components/MessageBubble.tsx` renders agent output as
  plain markdown. References to tasks, agents, notes, files are dead text.
- Delegate tool calls show up in the flat tool log; nothing indicates a
  child agent ran with its own transcript.

## Convention

Agents emit XML-style self-closing tags inside their normal markdown
output:

```
Created <task id="ptask_abc123"/> and reviewed <note id="note_xyz"/>.
See <file path="packages/core/src/agent/loop.ts" line="42"/>.
Delegated to <agent name="researcher"/>.
```

Document the convention in `CLAUDE.md` and bake it into the default chat
agent's instructions.

## Changes

### UI rendering
- `packages/ui/src/components/MessageBubble.tsx`: post-process the
  rendered HTML to swap matching tag patterns for React components.
- New components under `packages/ui/src/components/chips/`:
  - `TaskChip` — fetches the task via `fetchProjectTask(id)`, shows title
    + status pill, click opens the task detail in a drawer.
  - `AgentChip` — small avatar + name, hover shows description.
  - `NoteChip` — recall the note, show importance/tags on hover.
  - `FileChip` — path + line; click jumps to file viewer (use existing
    Resources page or open in new tab).
- Skeleton/loading state per chip; failed lookups render as inert text.

### Delegate visualization
- `packages/core/src/tools/delegate.ts`: include a `subagent: <name>` and
  `messages: <ChildMessage[]>` field in the structured tool result already
  returned. (Confirm it does — augment if missing.)
- Server SSE: when streaming a `tool_result` for `delegate`, include the
  subagent + child transcript in the payload (not just stringified result).
- `MessageBubble.tsx` / tool log: render delegate calls as a nested,
  collapsible block — header shows "→ delegated to {agent}", body is a
  miniature transcript with smaller bubbles.

## Acceptance

- Asking the chat agent "make me a task and reference it" produces a
  message that renders a clickable task chip.
- A delegate call from the agent appears as an indented sub-bubble with
  the child agent's name and inline transcript that can be collapsed.
- `pnpm run typecheck` + `pnpm run test` pass.
