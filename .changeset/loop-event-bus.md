---
"@tailored-ai/core": patch
---

The agent loop can be reached from outside it.

`runAgentLoop` had no event bus. It neither took one nor read one, and that
absence is why the loop keeps absorbing features that belong beside it:
`prompt.ts`, `context.ts`, `memory-inject.ts`, `chat-live-state.ts`,
`watcher.ts` and `load-skill.ts` each append their own block *from inside*,
because there was no way to subscribe to "a request is being assembled" and hand
one back.

`AgentLoopOptions.events` now carries an `EventBus`, populated by
`runtime.buildLoopOptions()` from `runtime.events` — so `delegate`, the schedule
runner, autopilot and the exploratory worker all get it without a line changing
at any of their call sites.

Optional, deliberately. The benchmark harness and most tests build their loop
options by hand, and a loop built without a runtime should dispatch to nobody
rather than refuse to run.

Nothing dispatches on it yet. That is the point of landing it alone: the seam
changes no behaviour and can be reviewed as a seam, while the first consumer —
a waterfall over prompt-slot assembly, which is what makes the dispatch mode
added earlier reach a real request — changes what a model reads and should be
reviewed on its own evidence.
