---
"@tailored-ai/core": patch
---

Say when a turn hit the output cap instead of returning an empty reply.

`agent.maxTokens` goes out as `max_completion_tokens`, which on a
reasoning model caps reasoning *plus* visible output rather than output
alone. A hard turn can spend the entire budget thinking and come back
with an empty message and `finish_reason: "length"`, billed in full.

The loop now recognises that case and reports it: which model answered,
what the cap was, how many output tokens were billed, and whether
reasoning is what consumed them — through `onStop` as
`{ kind: "truncated", … }`, and as the turn's returned text. An empty
assistant message is otherwise indistinguishable from a model that had
nothing to say, and that ambiguity is how this class of bug survives.

Checked before the nudge path, because nudging a model that ran out of
budget spends another round arriving at the same place. A reply that was
merely cut off mid-sentence is kept, with a warning rather than a
replacement — the partial answer is still worth more than the notice.

The cap itself is unchanged: it exists because OpenRouter reserves the
routed provider's full output window against the balance when the field
is absent and 402s at low balance. Per-rung `maxTokens` (`ModelEntry`)
is the knob for raising it where reasoning is on.
