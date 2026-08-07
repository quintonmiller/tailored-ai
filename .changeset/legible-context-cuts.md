---
"@tailored-ai/core": patch
---

Say when context was removed, in the two places it silently was.

**Trimmed history.** `trimHistory` drops the oldest messages and returns the
rest, so the model received a conversation that began mid-thought with nothing
indicating anything preceded it. It cannot tell "this is where we began" from
"the beginning was evicted", and answers as though the former. A one-line marker
now leads the trimmed history: `[System: N earlier messages in this conversation
are no longer shown. It continues from here.]`

The mechanism already existed — `summarizeOnTrim` inserts an
`[Earlier conversation summary: …]` marker — but it has no default, so the
silent path is the one nearly every deployment runs. The marker's cost is
reserved *before* trimming rather than prepended afterwards, which would push
the request back over the budget it was just cut to fit.

Deliberately a statement of fact with no instruction attached. "Ask if you need
anything from earlier" is the shape of instruction that gets taken up far more
often than intended, and an agent opening every turn by asking about its own
trimmed history is worse than one that does not know.

**Rooms that outran their backlog window.** When a cursor-based read comes back
full, the watcher jumps to the newest page so the message that woke the agent is
certainly included. Everything between the cursor and that page is skipped, and
the cursor then advances past it — and the result was handed over under the
heading `New messages:`, as though it were the whole story. That heading now
becomes `Most recent messages:`, preceded by a line saying the room moved faster
than the backlog window and messages were skipped. No count: the number is not
knowable without another round trip, and inventing one would be worse than
saying plainly that there is a gap.
