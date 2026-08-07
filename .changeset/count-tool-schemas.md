---
"@tailored-ai/core": patch
---

Tool schemas count against the history budget.

`historyBudget` subtracted the system prompt and the volatile tail from
`maxHistoryTokens`, then the request went out with the tool definitions on top,
unmeasured. They travel in their own request field rather than as a message, and
everything that estimated size walked the message list — so nothing ever looked
at them. The model reads every byte regardless.

Measured on a production deployment: 42 tools serialise to about 10,857 tokens,
roughly a 10% overshoot on a 110,000-token budget, paid on every request. A
13-tool agent pays about 3,852.

Nothing overflowed, because the primary model's window was well above the
configured budget — this shows up as cost rather than as failure. It matters
most on fallback, where each rung re-fits history against its own
`maxContextTokens` using the same arithmetic and is handed the identical
schemas, against a window that is usually much tighter.

The estimate is recomputed per round rather than once per turn, because
`getTools()` re-resolves per round and a turn can gain or lose tools mid-flight.

Deployments running close to their budget will see slightly more history trimmed
than before. That is the correction: the request was already this large.
