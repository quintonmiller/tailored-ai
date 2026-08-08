---
"@tailored-ai/core": patch
---

Let config reach sampling controls core does not model, via `providerExtra`

The generation call sent `temperature` and `max_tokens` and nothing else.
`ChatParams.extra` and the provider-side merge both already existed, but nothing
on the agent's path populated them, and the `providerExtra` config key reached
only `briefing` and `suggestions` — so a deployment had no way to set, say,
vLLM's `repetition_penalty`.

That is not hypothetical: `omega-evolution-27b` re-sends its own previous
message nearly verbatim (15/16, word-trigram overlap 0.90 against the agent's
own prior reply) and neither temperature nor prompt wording fixes it — an
explicit "do not repeat" instruction measured 20/20, worse than saying nothing.
`repetition_penalty: 1.15` takes it to 4/16.

`providerExtra` is now readable on `models[]` (per rung), `agents.<name>`, and
`agent`, and lands on `ChatParams.extra`. Core neither validates nor interprets
the keys, so provider plugins can expose their own controls without a core
change. A more specific level replaces the bag rather than merging into it,
because a chain mixes providers and the bag is provider-shaped.

Also fixes a stray NUL byte in `agent/agents.ts` — a dedup-key separator written
as the literal byte instead of a unicode escape, which made the file read as
binary to grep and every other text tool.
