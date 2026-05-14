---
# autonomous-agent-gi8w
title: DUX5 — Memory by default
status: completed
type: task
priority: high
created_at: 2026-05-14T05:30:54Z
updated_at: 2026-05-14T05:57:27Z
parent: autonomous-agent-p0ae
---

# DUX5 — Memory by default

Fixes pain point #7 (memory exists, agents barely use it).

## What's wrong today

- `injectMemory` and `summarizeOnTrim` are off by default on the chat
  agents in `config.yaml`, so the loop never pulls recall results into
  the system prompt.
- When injection *does* happen the user can't tell — the
  `[Relevant memory]` block is invisible.
- No automatic "write something to memory at end of conversation" hook,
  so notes are sparse and chats repeat themselves.

## Changes

### Config defaults
- `config.yaml`: flip `injectMemory: true` and `summarizeOnTrim: true`
  on the default chat-facing agents. Keep them off for fast-path/coder
  agents where prompt budget matters more.
- Add an `afterRun` hook on chat agents that calls
  `recall { action: "note", text: "{{response}}" }` with an importance
  derived from response length / tool count. Use `skipIf` to avoid
  recording trivial replies.

### Visibility
- `packages/core/src/agent/memory-inject.ts`: when memory is injected,
  emit a structured event/metadata (count + top-N note IDs).
- Server SSE chat stream: surface that as a `memory_recalled` event.
- `packages/ui/src/pages/Chat.tsx` (or `MessageBubble`): render a small
  "Recalled N notes" chip above the agent's reply; clicking lists the
  note titles and links to `#/memory`.

### Tuning
- `packages/core/src/agent/memory-inject.ts`: ensure the budget is honored
  (default 800 tokens) and the inject block is clearly bracketed so the
  model treats it as context, not instructions.

## Acceptance

- A second conversation about the same topic shows a "Recalled X notes"
  chip and the agent's reply references prior context without repeating.
- After 3+ chats, `#/memory` shows growing notes (count tile climbs).
- `pnpm run typecheck` + `pnpm run test` pass.
