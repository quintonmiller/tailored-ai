---
"@tailored-ai/core": patch
---

An agent can now pin world-state queries to its prompt: list them under `state.context` (or `agent.defaults.state.context`), and the matching records render behind the conversation on every turn, scoped exactly as the agent's own `state` tool reads would be, including the rooms a room wake is about. Context slots may now render asynchronously: `render` can return a promise, which the agent loop awaits through the new `renderContextSlotsAsync`. The synchronous `renderContextSlots` is unchanged for synchronous slots.
