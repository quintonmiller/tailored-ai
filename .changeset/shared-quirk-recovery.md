---
"@tailored-ai/core": patch
"@tailored-ai/provider-openai": patch
"@tailored-ai/provider-anthropic": patch
---

One shared ladder for providers that learn a model's quirks from its 400s.

Three providers had grown the same pattern independently — a bounded
attempt ladder, a per-model memo of what the API refused, and warn-once
plumbing — because the underlying problem is general: a per-model
request-shape constraint that no static rule predicts, discoverable only
by being told no.

`runQuirkLadder`, `QuirkMemo` and `WarnOnce` now live in core next to the
provider interface. `provider-openai` (both endpoints) and
`provider-anthropic` use them.

Recognition stays per-provider, deliberately. Which 400s are recoverable
and what the corrected shape is, is vendor knowledge that does not
generalise — every vendor words the same refusal differently, and OpenAI
words it differently between its own two endpoints. A shared table of
error patterns would be wrong within a release.

Termination stays structural: a shape whose key has already been tried is
never tried again, so the loop is bounded by the number of distinct
shapes rather than a retry counter. The error text is the *input* to
recovery, so a reworded message must cost a missed recovery, never a
hang.

`ProviderHttpError` comes along, carrying status and body to the
recognition step. Without it the only thing reaching `recover` is a
message the provider formatted two lines earlier, and deciding "was that
a 400?" by matching that string is the same mistake as inferring control
flow from a model's prose. The message is unchanged, so anything catching
or asserting on it is unaffected.

No behaviour change: all 137 existing provider tests pass untouched.
