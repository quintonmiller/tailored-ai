---
"@tailored-ai/core": patch
---

Size the history to the fallback rung that gets it, not to the chain head.

`historyBudget` was computed once, from `maxHistoryTokens`, before any
request was made — and every rung was then tried against that same
budget. A chain whose later rungs have smaller context windows could
build a request the head accepts and the fallback cannot. The failure was
not silent, but it wasted the rung, and if every remaining rung is
smaller than the head the turn fails looking like an outage rather than a
budget mistake.

`ModelEntry.maxContextTokens` already existed and was only read by the
`/context` display. It now reaches the chain: a rung declaring a window
smaller than `maxHistoryTokens` gets its history re-trimmed to fit, with
a log line naming what was dropped and for whom. The window covers the
whole request, so the system prompt comes out of it too.

Re-trimmed only when the rung is actually smaller, so the common case — a
chain of one, or every rung roomy — reuses the assembled array and pays
nothing.

The re-trim is the plain one even under `summarizeOnTrim`. Summarising is
an async model call, and spending one on the degraded path to produce a
prettier request the rung might still reject is the wrong trade.

`chatWithFallback`'s `params` argument now also accepts a function of the
candidate, which is how the loop supplies a per-rung request. A plain
object behaves exactly as before.
