---
"@tailored-ai/core": patch
"@tailored-ai/cli": patch
---

Raise the default `agent.maxHistoryTokens` above the tool-schema floor

It was 2,000, set before tool schemas counted against the history budget. Once
they did, the budget became

    max(0, maxHistoryTokens - systemPrompt - tail - toolSchemas)

and the schemas are the largest term by an order of magnitude — a 24-tool agent
costs ~6,200 tokens before a single message, a 41-tool one ~10,900. Both are
over 2,000, so the budget clamped to zero: an install that never tuned this
dropped its whole conversation on every turn and looked like a model with no
memory rather than a configuration that could not hold one.

The default is now 20,000, which is what `tai init` had been writing all along —
so this fixes the untuned path rather than changing the tuned one. Nothing
changes for an existing config, which already carries an explicit value.

20,000 rather than a share of `maxContextTokens`: deriving it would make a
deployment that declares a 200k window spend 200k per turn, and the window says
what a model accepts, not what an operator wants to pay.

`validateConfig` now warns when `maxHistoryTokens` is not smaller than
`maxContextTokens` — a request budget larger than the window it must fit in,
which otherwise surfaces as a provider rejection on a grown session, a long way
from the config that caused it. A small-context deployment should lower the
budget, and is told so at load rather than at failure.
