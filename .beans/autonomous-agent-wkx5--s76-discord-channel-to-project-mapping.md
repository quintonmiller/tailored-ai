---
# autonomous-agent-wkx5
title: 'S7.6: Discord channel-to-project mapping'
status: completed
type: task
priority: normal
created_at: 2026-05-04T06:21:00Z
updated_at: 2026-05-04T06:59:24Z
parent: autonomous-agent-bv73
---

Implemented:
- New config field `channels.discord.projectMappings: Array<({channel: string} | {dm: true}) & {project: string}>`. First matching entry wins.
- `DiscordChannel.resolveMessageProject(msg)` looks up the mapping per incoming message; warns and falls back to global mode for unknown or path-less project ids.
- Session keys are project-namespaced when a mapping matches: `discord:<projectId>:<userId>` instead of bare `discord:<userId>`. The same Discord user in two mapped channels gets isolated histories (and the dedup `processing` set lets them run in parallel).
- `runAgentAndReply` accepts an optional project context; threads it through `findOrCreateSession` and `runtime.buildLoopOptions({project})` so the agent loop runs in the project's path.
- Slash-command paths (the `/new`, `/help`, etc. handlers) reuse the same project-aware userKey, so resets and compactions stay within their project bucket.

Out of scope (noted as follow-ups):
- A `/project` slash command surfacing "this channel maps to project X" is not in this slice.
- Discord interaction handlers (autocomplete, button clicks) at lines 613/684/763 still use bare `discord:<userId>` keys for now — they're rarer paths and don't share state with the main message flow.

Tests: 6 new (`project-discord.test.ts`) — no mappings → null; channel match; DM-only match; first-match wins; unknown project warns + null; path-less project warns + null. 430 total passing.

Next: S7.7 (HTTP routes + UI project switcher).
