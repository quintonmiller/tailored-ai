---
# autonomous-agent-easr
title: DUX7 — Conversational shape
status: todo
type: task
priority: normal
created_at: 2026-05-14T05:30:54Z
updated_at: 2026-05-14T05:30:54Z
parent: autonomous-agent-p0ae
---

# DUX7 — Conversational shape

Fixes pain point #2 (chat is request/response-shaped; agent questions
feel disconnected).

## What's wrong today

- The chat loop is one-shot: user → loop → reply. If an agent needs more
  info, it has to embed the question in its reply and hope the user picks
  up the thread.
- Approvals exist as a special-case pause; nothing similar for free-form
  agent questions or choice questions.

## Convention

Agents emit an `<ask>` tag when they need user input mid-loop:

```
<ask kind="choice" choices="yes,no,defer">
  Should I migrate the old <code>profiles:</code> key in config.yaml now?
</ask>
```

`kind` is `text` (free response) or `choice` (with `choices`).

## Changes

### Loop
- `packages/core/src/agent/loop.ts`: detect `<ask>` in the model's
  response; treat as a pause similar to the existing approval gate.
  Emit an SSE `agent_question` event with the question payload; do not
  send another model request until the user answers.
- Resume path: the next user message is threaded as a reply.

### Schema
- `packages/core/src/db/schema.ts`: add nullable `messages.in_reply_to TEXT`.
- Persist the parent message ID when a reply is recorded.

### UI
- `MessageBubble.tsx`: render `<ask kind="choice">` as a card with
  clickable choices; rendered inline where the assistant emitted it.
- Free-text asks render with an inline composer scoped to that turn so
  the reply is visually anchored under the question.
- The dock surfaces an "agent is waiting on you" indicator (re-uses the
  approval-badge mechanism from DUX2).

## Acceptance

- An agent that emits `<ask kind="choice" choices="yes,no">` pauses;
  clicking a choice resumes the loop with the chosen value as the next
  user message.
- The reply is threaded under the question in the transcript.
- Approvals still work; the two pause mechanisms coexist cleanly.
- `pnpm run typecheck` + `pnpm run test` pass.
