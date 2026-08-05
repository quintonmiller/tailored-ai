---
"@tailored-ai/provider-openai": patch
---

Add Responses API support, so reasoning models can call tools while reasoning.

`/v1/chat/completions` refuses function tools alongside any reasoning effort on
`gpt-5.4`, `gpt-5.5` and the whole `gpt-5.6` family, and does not serve
`gpt-5.3-codex` at all. TAI always sends tools, so on those models reasoning and
tool use were mutually exclusive. Measured 2026-08-05, tools present:

| model | `/v1/chat/completions` | `/v1/responses` |
|---|---|---|
| gpt-5.4, 5.5, 5.6-* | reasoning impossible | every effort accepted |
| gpt-5.3-codex | not served | accepted |
| gpt-5-mini, o4-mini | rejects `none` | rejects `none` |
| gpt-5.3-chat-latest | only `medium` | only `medium` |

`OpenAIResponsesProvider` implements the same `AIProvider` contract against
`/v1/responses`: `input[]` instead of `messages[]`, flat tool declarations,
`function_call` / `function_call_output` items keyed by `call_id`, the typed
event stream, and `input_tokens`/`output_tokens` usage.

Endpoint choice is made **per call** against `params.model`, not once when the
provider is built — an agent, a per-call override or a fallback-chain rung can
each name a different model, and deciding from `defaultModel` would send an
overridden model to the wrong endpoint. `api: auto` (default) routes only the
models chat completions cannot serve, and only against `api.openai.com`, so a
`baseUrl` pointing at a proxy or gateway is unaffected. `api: chat` and
`api: responses` pin it.

Per-model reasoning quirks survive the move, so they are learned from the API's
own refusals rather than hardcoded — keyed on the structured `param`/`code`
fields, since the prose differs from chat-completions for the same condition
(`'none' is not supported with the 'gpt-5-mini' model` versus
`'reasoning_effort' does not support 'none'`). A rejected effort is replaced
with the *nearest* one the model accepts, ties going to the cheaper: `off` on
gpt-5-mini becomes `minimal`, not the `high` that appears first in the error's
list.

Reasoning items are replayed on the next turn so the model continues the chain
it started instead of re-deriving it (30 versus 45 reasoning tokens, measured).
Contrary to what #378 assumed this is an optimisation, not a requirement —
dropping the items returns 200 — so it is a provider-private cache keyed by
tool-call id rather than a widening of `Message`, and core's rule that
`Message.reasoning` is never sent back to a provider still holds.

Also new: `reasoningSummary` (the readable trace, auto-downgraded for orgs not
verified to generate summaries) and `store` (default `false`, matching chat
completions, which retains nothing unless asked).

Verified live against gpt-5.6-luna, gpt-5.5, gpt-5-mini, gpt-5.3-chat-latest,
gpt-5.3-codex and o4-mini, streaming and non-streaming.
