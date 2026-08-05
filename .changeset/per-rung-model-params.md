---
"@tailored-ai/core": patch
---

Let each rung of a fallback chain carry its own reasoning effort.

`ModelEntry` held `provider`, `model` and `maxContextTokens`. Reasoning
effort was resolved per call (global `agent.thinking`, or a per-agent
value) or per provider (`defaultThinking`) — never per rung. So a chain
that heads at a small local model and falls back to a strong cloud
reasoner had one `thinking` value to serve both: set it for the head and
the fallback is wasted, set it for the fallback and the head is burdened.
`defaultThinking` got close but is keyed by provider, so a cheap and an
expensive model on the same vendor still could not differ.

`thinking`, `temperature` and `maxTokens` are now per-rung. Absent means
inherit whatever the call resolved, so an existing chain behaves exactly
as it did.

`maxTokens` is included deliberately rather than only `thinking`: it caps
reasoning *plus* visible output, so a rung that reasons harder generally
needs a bigger cap than the one it falls back from.

This became worth asking for with the Responses API work — reasoning and
tool calls can now coexist, so "reason harder on the cloud rung" is a
real request.
