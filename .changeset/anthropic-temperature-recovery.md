---
"@tailored-ai/provider-anthropic": patch
---

Stop `claude-sonnet-5` from 400-ing on every call.

Newer Claude models answer any `temperature` with "`temperature` is deprecated
for this model." Supplying none is not a workaround, because the 0.3 default is
applied by this plugin rather than by the API — so every call to those models
failed, whatever the caller passed.

The model is now learned from its own refusal: on that specific 400 the request
is retried once without `temperature`, and the model is remembered for the rest
of the process. A one-time warning names it, because `agent.temperature`
genuinely stops applying there and nothing else would reveal that. Any other
400, and any 400 after the field has already been dropped, is rethrown
untouched.

Found while verifying a fallback chain end to end: `claude-sonnet-5` was
configured as a last-resort rung, and would have failed at exactly the moment it
was needed. The plugin already dropped `temperature` when extended thinking was
enabled; this is the same handling for the models that reject it outright.
