# @tailored-ai/provider-openai

## 0.1.10

### Patch Changes

- b8f5d16: Record prompt-cache tokens, so a change to request layout can be measured.

  `ChatResponse.usage` carried `{ input, output }` only, and the Anthropic provider
  sums cache reads and writes _into_ its input figure — so a perfect cache hit and
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

- a970a8b: First-class reasoning support (#254). Providers now capture their reasoning
  trace into `ChatResponse.reasoning` (and a streamed `reasoning` event), and a
  provider-agnostic `thinking` level (`off`/`auto`/`low`/`medium`/`high`) on
  `ChatParams` maps to each provider's wire format — `reasoning_effort` (OpenAI),
  `thinking:{type}` (DeepSeek), `thinking` budgets (Anthropic / Bedrock
  `reasoning_config`), `chat_template_kwargs.enable_thinking` (vLLM via the
  `openai_compatible` `thinkingDialect`). Set it per provider
  (`providers.<id>.thinking`) or per agent (`agents.<name>.thinking`). Reasoning
  is persisted on the assistant message and rendered as a collapsible "Thinking"
  disclosure in the chat UI, and is stripped from every outgoing request so it
  never re-enters the model. Retires the per-plugin `thinking` hack in
  provider-deepseek (its boolean config still works).
- 9eaadfb: Stop the modern GPT-5 lineup from 400-ing whenever tools are present.

  On `/v1/chat/completions`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.5` and the whole
  `gpt-5.6` family reject `reasoning_effort` alongside function tools — and the
  5.6 models reject the request even with **no** effort field, because omitting it
  is not the same as sending `"none"`. TAI always sends tools, so every call to
  those models failed: with a thinking level set, and without one.

  Older reasoning models are the mirror image: `gpt-5`, `gpt-5-mini`, `o3` and
  `o4-mini` accept a real effort and reject `"none"`. And `gpt-5.3-chat-latest`
  rejects both, accepting only `'medium'`. Measured 2026-08-05:

  | model                          | `"none"` | real effort + tools      |
  | ------------------------------ | -------- | ------------------------ |
  | gpt-5, gpt-5-mini, o3, o4-mini | rejected | accepted                 |
  | gpt-5.1, gpt-5.2               | accepted | accepted                 |
  | gpt-5.3-chat-latest            | rejected | rejected (only `medium`) |
  | gpt-5.4, 5.4-mini, 5.5, 5.6-\* | accepted | rejected                 |

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

- 94c556a: Add Responses API support, so reasoning models can call tools while reasoning.

  `/v1/chat/completions` refuses function tools alongside any reasoning effort on
  `gpt-5.4`, `gpt-5.5` and the whole `gpt-5.6` family, and does not serve
  `gpt-5.3-codex` at all. TAI always sends tools, so on those models reasoning and
  tool use were mutually exclusive. Measured 2026-08-05, tools present:

  | model                | `/v1/chat/completions` | `/v1/responses`       |
  | -------------------- | ---------------------- | --------------------- |
  | gpt-5.4, 5.5, 5.6-\* | reasoning impossible   | every effort accepted |
  | gpt-5.3-codex        | not served             | accepted              |
  | gpt-5-mini, o4-mini  | rejects `none`         | rejects `none`        |
  | gpt-5.3-chat-latest  | only `medium`          | only `medium`         |

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
  with the _nearest_ one the model accepts, ties going to the cheaper: `off` on
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

- 2963457: One shared ladder for providers that learn a model's quirks from its 400s.

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
  shapes rather than a retry counter. The error text is the _input_ to
  recovery, so a reworded message must cost a missed recovery, never a
  hang.

  `ProviderHttpError` comes along, carrying status and body to the
  recognition step. Without it the only thing reaching `recover` is a
  message the provider formatted two lines earlier, and deciding "was that
  a 400?" by matching that string is the same mistake as inferring control
  flow from a model's prose. The message is unchanged, so anything catching
  or asserting on it is unaffected.

  No behaviour change: all 137 existing provider tests pass untouched.

- Updated dependencies [b559646]
- Updated dependencies [ef9e809]
- Updated dependencies [a2f8016]
- Updated dependencies [ed98f4a]
- Updated dependencies [b559646]
- Updated dependencies [920a799]
- Updated dependencies [fecc3d8]
- Updated dependencies [2632f51]
- Updated dependencies [9af06b7]
- Updated dependencies [b8f5d16]
- Updated dependencies [aee6802]
- Updated dependencies [9d32c15]
- Updated dependencies [8b0c45a]
- Updated dependencies [f67b15a]
- Updated dependencies [7447619]
- Updated dependencies [fd84749]
- Updated dependencies [b559646]
- Updated dependencies [d9e294f]
- Updated dependencies [b1ec29a]
- Updated dependencies [fd19549]
- Updated dependencies [a38b5fc]
- Updated dependencies [1206560]
- Updated dependencies [0a3b591]
- Updated dependencies [dc312f1]
- Updated dependencies [5a01ceb]
- Updated dependencies [b1cdad9]
- Updated dependencies [0fb08f4]
- Updated dependencies [0fb08f4]
- Updated dependencies [0fb08f4]
- Updated dependencies [54ce46f]
- Updated dependencies [7017c2d]
- Updated dependencies [7d273b5]
- Updated dependencies [b559646]
- Updated dependencies [e6cb5fb]
- Updated dependencies [e66f07b]
- Updated dependencies [0187e0c]
- Updated dependencies [b559646]
- Updated dependencies [daa6302]
- Updated dependencies [a970a8b]
- Updated dependencies [57a5d48]
- Updated dependencies [39445bb]
- Updated dependencies [4c48ad8]
- Updated dependencies [ba7bad5]
- Updated dependencies [571adba]
- Updated dependencies [de1ce69]
- Updated dependencies [87fc6fd]
- Updated dependencies [611f94d]
- Updated dependencies [8aa5720]
- Updated dependencies [d2b5939]
- Updated dependencies [7e9a130]
- Updated dependencies [b559646]
- Updated dependencies [d3a4cf1]
- Updated dependencies [36a50b7]
- Updated dependencies [4656518]
- Updated dependencies [d3e79e3]
- Updated dependencies [128c561]
- Updated dependencies [30a0c14]
- Updated dependencies [df2d055]
- Updated dependencies [9ccec1f]
- Updated dependencies [e698f39]
- Updated dependencies [b8fe10c]
- Updated dependencies [0d4f4b6]
- Updated dependencies [6460c00]
- Updated dependencies [0039c3a]
- Updated dependencies [8d0f50e]
- Updated dependencies [9b13c86]
- Updated dependencies [c120f51]
- Updated dependencies [7c6217a]
- Updated dependencies [449e827]
- Updated dependencies [58dd367]
- Updated dependencies [bbcde3b]
- Updated dependencies [2c0fde1]
- Updated dependencies [0b7a0f7]
- Updated dependencies [19188db]
- Updated dependencies [20f9fe1]
- Updated dependencies [7f620a0]
- Updated dependencies [b559646]
- Updated dependencies [9883913]
- Updated dependencies [77781ef]
- Updated dependencies [b7788ad]
- Updated dependencies [7e05a94]
- Updated dependencies [e3b1bc5]
- Updated dependencies [920a799]
- Updated dependencies [920a799]
- Updated dependencies [b559646]
- Updated dependencies [682e304]
- Updated dependencies [d492806]
- Updated dependencies [dd3951c]
- Updated dependencies [544aac2]
- Updated dependencies [87d2af3]
- Updated dependencies [c308241]
- Updated dependencies [cc792f2]
- Updated dependencies [7d273b5]
- Updated dependencies [42a1e90]
- Updated dependencies [2963457]
- Updated dependencies [9ec3100]
- Updated dependencies [248931d]
- Updated dependencies [4b54275]
- Updated dependencies [22f9b9e]
- Updated dependencies [d7656d8]
- Updated dependencies [afc05a2]
- Updated dependencies [dd3951c]
- Updated dependencies [1ad506a]
- Updated dependencies [a1231c6]
- Updated dependencies [1d9e6a6]
- Updated dependencies [f0bb132]
- Updated dependencies [19996ac]
- Updated dependencies [28bb474]
- Updated dependencies [244cdcf]
- Updated dependencies [a00b73a]
- Updated dependencies [b559646]
- Updated dependencies [c50e55a]
- Updated dependencies [bcc2159]
- Updated dependencies [42d98c6]
- Updated dependencies [b8a8da4]
- Updated dependencies [cf2cd34]
  - @tailored-ai/core@0.1.10

## 0.1.9

### Patch Changes

- Updated dependencies [4f992c9]
  - @tailored-ai/core@0.1.9

## 0.1.8

### Patch Changes

- eb0e5d2: New plugin: OpenAI provider — max_completion_tokens, reasoning-model temperature handling, org/project headers, streaming, listModels. Registers `openai`, superseding the minimal built-in.
- Updated dependencies [c67120e]
- Updated dependencies [ecb0d69]
- Updated dependencies [a6e26a4]
- Updated dependencies [e0b9bbe]
- Updated dependencies [c83c58c]
- Updated dependencies [e4e239f]
- Updated dependencies [d398c93]
- Updated dependencies [c71e7de]
- Updated dependencies [08ac997]
- Updated dependencies [ef7fe84]
- Updated dependencies [ff81e89]
- Updated dependencies [290f96d]
- Updated dependencies [04181f5]
- Updated dependencies [330a6c5]
- Updated dependencies [d927a26]
- Updated dependencies [02c0a5a]
- Updated dependencies [98160f3]
- Updated dependencies [14fdab3]
- Updated dependencies [ba79819]
- Updated dependencies [04181f5]
- Updated dependencies [f240f5e]
- Updated dependencies [10bfad3]
- Updated dependencies [c759128]
- Updated dependencies [a655023]
- Updated dependencies [877795c]
- Updated dependencies [773e16c]
- Updated dependencies [1747dbe]
- Updated dependencies [ef1e01c]
- Updated dependencies [cdc0034]
  - @tailored-ai/core@0.1.8
