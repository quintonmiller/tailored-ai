---
"@tailored-ai/core": patch
"@tailored-ai/cli": patch
---

Agents with bodies can share a place. The `place` tool's new `new`, `go` and `places` actions make a shared room, go to it or home, and list where each agent is. Edits apply to the place the agent is in. Where each agent is is a `whereabouts` world-state record. The chat page shows everyone in the place, each in its own body with a name label, wandering on its own, and the agent you are talking to is told who is with it and can look or point at them. Photos include them. The stage's per-body code moved into a `Figure`, so every body walks, sits and gestures the same way.
