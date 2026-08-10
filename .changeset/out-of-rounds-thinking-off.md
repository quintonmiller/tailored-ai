---
"@tailored-ai/core": patch
---

The out-of-rounds answer stops thinking and starts answering.

A turn that exhausts its tool rounds gets one more request with the tools
withheld, so prose is the only thing the model can produce. That call inherited
the turn's thinking setting — and on a reasoning model it spent the whole
`maxTokens` budget on a reasoning trace, returned empty `content`, and fell back
to `[Agent stopped: max tool rounds reached]`: the exact marker the path exists
to replace.

Measured on the benchmark's `notices-a-truncated-tool-result` against a 27B
local model at the reference deployment's `maxTokens: 8192`, five runs each:

| | pass | output tokens | wall clock |
|---|---|---|---|
| before | 2/5 | 874 – 9,329 | 697s |
| after | 4/5 | 669 – 1,525 | 236s |

Every failing run before the change landed just above the 8,192-token cap. None
of them said anything.

Nothing is left to reason about at that point — everything the answer reports is
already in the messages above it — so the call now sets `thinking: "off"`. The
remaining failure is the model genuinely misreading a truncation marker, which
is the behaviour the scenario is for.

An empty answer now also logs why (finish reason, reasoning length, output
tokens). Previously a turn ending on the marker looked identical whether the
model was never asked, refused, or burned its budget before writing a word.
