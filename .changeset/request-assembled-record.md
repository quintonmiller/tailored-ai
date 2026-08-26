---
"@tailored-ai/core": patch
---

The loop says what it assembled.

Nothing outside `runAgentLoop` could see what a model was actually shown. The
system prompt is composed from a dozen contributors, the history is trimmed to a
budget, tool schemas are a separate request field, and by the time all of that
is one `ChatParams` object it exists only for the duration of a provider call.
"Why did it say that" was answerable by reading code and guessing.

`agent.request_assembled` is emitted once per request that reaches a provider,
carrying the request itself plus what the loop knows and the request does not:
which round and phase, which fallback rung sent it and whether that rung
answered, the history length the request was trimmed from, and what each context
slot contributed — including whether its own budget cut it short.

**A faithful copy, not a projection.** Rebuilding the request later from session
state would be cheaper and would be wrong: `paramsFor` re-trims the history for
each fallback rung, so which messages went out depends on which rung answered,
and a reconstruction could not know that. It would confidently produce the head
rung's request instead, and authoritative-and-wrong is worse than absent. The
test asserts object identity rather than deep equality, so a shaping step
inserted between the record and the wire fails the build.

Emitted after the request was sent, in a `finally` around the provider call, so
an observer can neither see a request that did not go out nor change one that
did. That is why it is a broadcast rather than a waterfall: a subscriber able to
rewrite this would make the record a lie.

Core emits and stores nothing — retention, redaction and format are opinions and
belong to a subscriber. `renderContextSlots` also now returns a per-slot
breakdown (`id`, `refresh`, `chars`, `truncated`) alongside the two blocks it
already placed, which is the cheap half of asking where a request's size comes
from.
