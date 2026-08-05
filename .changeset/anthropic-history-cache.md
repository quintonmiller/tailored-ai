---
"@tailored-ai/provider-anthropic": patch
---

Cache the message history, and turn prompt caching on by default.

Anthropic caches what you mark and nothing else. This plugin marked the
last system block and the last tool definition, and stopped — so the
conversation, which is the bulk of the prompt and the part that grows,
was re-read at full input price on every round. Against the reference
deployment's traffic that made ~23% of the prompt cacheable, versus ~86%
for OpenAI and DeepSeek, which cache the whole prefix automatically.
Priced on the same workload the gap was $317-634/mo against $18-27/mo,
and most of it was the integration rather than the sticker price.

A third breakpoint now rides on the message history. It sits on the
*second-to-last* message: the tail is rewritten every turn, so one
message back is the newest point that is still a prefix of the next
request, and each turn reads what the previous one wrote while writing
only its own delta. Three of the four breakpoints the API allows are now
in use.

It is skipped when the prefix is under the minimum cacheable length
(1024 tokens, 2048 for Haiku), because a breakpoint below the floor is
accepted and silently ignored — which is indistinguishable from one that
works. For the same reason the provider now checks
`cache_creation_input_tokens` / `cache_read_input_tokens` on the
response and warns once per model if a marked request cached nothing.

`promptCaching` now defaults to **true**. An agent loop re-sends the
system prompt, the tools and the history on every one of its calls;
off-by-default meant a correct integration quietly cost several times
what it needed to. Set `promptCaching: false` to send no breakpoints.
