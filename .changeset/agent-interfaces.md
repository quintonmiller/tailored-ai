---
"@tailored-ai/core": patch
"@tailored-ai/server": patch
"@tailored-ai/provider-anthropic": patch
"@tailored-ai/provider-bedrock": patch
"@tailored-ai/channel-slack": patch
---

Agent interfaces: an agent can send a choice, a form, a confirmation or a card
instead of plain text.

TAI already had three one-off ways to ask a person something structured —
`<ask>` tags, workflow form steps, approval buttons — each stuck on one
surface. This is the general mechanism they can all move onto.

- A component is a third kind of content part, beside text and media. Core
  writes a text form for it when it is created and stores it with it: that is
  what a model reads, and what any surface that cannot draw it posts.
- An `interface` tool with `send`, `update` and `close`. Four built-in kinds
  (`choice`, `form`, `confirm`, `card`), each a schema and a text form in an
  open registry; plugins add kinds through `ctx.componentKinds`.
- A button's effect is `reply`, where the answer continues the conversation as
  the person's next message, or `event`, announced as `interface.action` for
  subscriptions and hooks. A component takes one answer; a late, repeated or
  closed one is refused with a reason.
- The web UI draws components under the reply, live as the tool runs, and
  draws answered, closed and expired ones finished. Discord, Slack and rooms
  post the text form with the agent's reply, read from the turn's stored
  messages the way its media already is (`collectTurnComponents`).
- `GET /api/interfaces`, `GET /api/interfaces/:id`, and
  `POST /api/interfaces/:id/respond`.
- Components never reach a provider raw: `adaptForCapabilities` turns them into
  their text form, and each provider falls back to it if one gets through.
- `onToolResult` now also receives the tool's output, so a surface can draw
  parts as they arrive.
