---
"@tailored-ai/core": patch
"@tailored-ai/provider-anthropic": patch
"@tailored-ai/provider-openai": patch
---

Record prompt-cache tokens, so a change to request layout can be measured.

`ChatResponse.usage` carried `{ input, output }` only, and the Anthropic provider
sums cache reads and writes *into* its input figure — so a perfect cache hit and
a completely cold read stored identical numbers. Prompt-cache behaviour is the
main reason to care about how a request is ordered, and nothing anywhere could
tell whether a change to it had helped or hurt.

`usage` now carries optional `cacheRead` / `cacheWrite`, `token_usage` stores
them as nullable columns, and `/api/usage` sums them.

Optional on purpose. Only some vendors report caching, and making every provider
invent a number would be worse than an honest absence: `undefined`, stored as
`NULL`, means "this provider does not say", which is a different fact from a
reported zero. A reported zero is itself a useful signal — it means the prefix
missed.

Reported alongside `input` rather than carved out of it, because vendors
disagree about whether cached tokens are already counted in the input total, and
subtracting centrally would double-correct for some of them.

Wired up: Anthropic (both), OpenAI Responses (read — the API reports no write,
and the field was already parsed and then dropped), and the built-in
`openai_compatible` provider when the server sends
`prompt_tokens_details.cached_tokens`. Every other provider reports nothing and
stores NULL, exactly as before.

Existing rows keep their values and stay NULL. Verified against a production
database of 12,471 usage rows.
