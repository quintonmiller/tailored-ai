---
"@tailored-ai/provider-openai": patch
---

Stop the modern GPT-5 lineup from 400-ing whenever tools are present.

On `/v1/chat/completions`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5` and the whole
`gpt-5.6` family reject `reasoning_effort` alongside function tools — and the
5.6 models reject the request even with **no** effort field, because omitting it
is not the same as sending `"none"`. TAI always sends tools, so every call to
those models failed: with a thinking level set, and without one.

Older reasoning models are the mirror image: `gpt-5`, `gpt-5-mini`, `o3` and
`o4-mini` accept a real effort and reject `"none"`. And `gpt-5.3-chat-latest`
rejects both, accepting only `'medium'`. Measured 2026-08-05:

| model | `"none"` | real effort + tools |
|---|---|---|
| gpt-5, gpt-5-mini, o3, o4-mini | rejected | accepted |
| gpt-5.1, gpt-5.2 | accepted | accepted |
| gpt-5.3-chat-latest | rejected | rejected (only `medium`) |
| gpt-5.4, 5.4-mini, 5.5, 5.6-* | accepted | rejected |

No model-id rule covers that table — a prefix test is already wrong for
`gpt-5.3-chat-latest` and would rot with the next release — so the provider now
learns from the API's own 400s. On a recognised complaint it corrects the shape
and retries once, then remembers per model for the rest of the process. When the
error names the levels it does accept ("Supported values are: 'medium'"), that
value is used rather than dropping reasoning entirely.

A reasoning level that cannot be honoured is dropped with a one-time warning
naming the model and pointing at the Responses API, rather than silently: the
request succeeds either way, so nothing else would reveal it. Any 400 that is
not one of the two recognised messages is rethrown untouched.

Verified live against all seven affected model/level combinations.
