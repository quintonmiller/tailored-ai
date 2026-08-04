---
"@tailored-ai/core": patch
---

Agents can cap generated tokens per call with `maxTokens`.

`ChatParams.maxTokens` and the providers' `max_tokens` mapping both existed
already, but nothing populated them, so every agent request went out with the
field absent. Locally that costs nothing. On a metered provider it can make the
account unusable: OpenRouter reserves the model's full output window — 65536
tokens — against the balance for the duration of each call when `max_tokens` is
missing, and returns 402 as soon as the balance no longer covers the
reservation, however small the actual reply would have been. The symptom is a
provider refusing every request while the account is nominally in credit.

Resolution is `agents.<name>.maxTokens` → `agent.maxTokens` → omitted. Omitted
stays the default, so no existing deployment changes behaviour: picking a
number here would cap generation for everyone who never asked for one, and
providers already carry sensible defaults of their own.
