# Choosing a cloud model (and falling back off a local one)

Notes from a measured survey run 2026-08-04, when the question was "what do we
run if vLLM is off?" The numbers come from the reference deployment's real
traffic and from probing each candidate with an actual tool-calling request.
Re-run the harness (`scripts/probe-models.mjs`) rather than trusting the table:
model ids, prices and API restrictions all moved inside a single quarter.

## Price the cache-read column first

TAI's traffic is overwhelmingly input. Over a busy 48 hours the reference
deployment sent **25.9M prompt tokens and 0.13M completion tokens** — input was
**99.5%** of everything billed. Output price is close to irrelevant; the column
that decides the bill is the cached-input price, which varies far more between
vendors than the headline rate does (deepseek-v4-pro reads cache at $0.0036/M,
kimi-k2.6 at $0.20/M — 55x, at comparable quality).

How much of that input is actually cacheable is a property of *TAI's* prompt
layout, not of the model:

- Within one run the system prompt is composed once (`loop.ts`, before the
  round loop) and history only grows, so every round after the first presents a
  prefix the provider has already seen. With **7.8 rounds per run** on average,
  that alone makes ~86% of prompt tokens cache-eligible.
- Across runs, almost nothing carries over: `renderChatLiveState` writes a
  millisecond-precision `**Now:**` line into the `chat_live_state` layer, and
  everything after that point in the request — `recall_memory` plus the entire
  message history — is a cache miss on the next run. Moving that timestamp, or
  the layer, would raise the ceiling above 86%.

To estimate the cacheable fraction for a deployment, group `token_usage` rows
into runs and treat each run's largest prompt as the only fresh tokens:

```sql
with runs as (
  select session_id, cast(strftime('%s', created_at)/600 as int) bucket,
         sum(prompt_tokens) total, max(prompt_tokens) fresh
  from token_usage where source='loop' and created_at >= datetime('now','-48 hours')
  group by session_id, bucket)
select round(100.0*(1 - sum(fresh)*1.0/sum(total)),1) as est_cache_hit_pct from runs;
```

A live probe measured 88% against this estimate's 86%, so it holds up.

## Caching is not uniform, and vendors do not advertise this

Measured over two trials, same request, second call identical to the first:

| Model | measured cache hit | notes |
|---|---|---|
| deepseek-v4-pro / v4-flash | 97-99% | reliable across every run |
| gpt-5.6-luna | 99% | reliable |
| minimax-m3 | 97-98% | reliable |
| gpt-5-mini | 46-97% | engages, but the fraction swings |
| glm-4.7-flash | 0-99% | **engaged in one run, absent in another** |
| qwen3.7-plus | 34-51% | erratic |
| qwen3.7-flash | 0-36% | frequently no cache; also 429s under light load |
| gemini-3.5-flash-lite | 0% | never cached, 6/6 calls |

Consistency matters more than the peak. glm-4.7-flash looks like the cheapest
credible option at 98% and a nearly unusable one at 0% — the same model, the
same request, two runs an hour apart. Budget for the bad case: at 0% cache it
costs $23/mo against this workload rather than $7/mo.

Routed models inherit their upstream provider's caching, so an OpenRouter id is
not one behaviour but several depending on which backend served the call. Prefer
a direct vendor API for anything that has one.

Assuming the advertised discount applies is the single biggest way to get a
cost estimate wrong. Repricing gemini-3.5-flash-lite at its *measured* 0%
moved it from $32/mo to $121/mo against the reference workload, from mid-table
to the most expensive non-frontier option considered.

## Vendor-specific restrictions that bite

**The GPT-5.6 family cannot use function tools on `/v1/chat/completions`**
unless `reasoning_effort` is exactly `"none"`:

```
400: Function tools with reasoning_effort are not supported for gpt-5.6-luna
     in /v1/chat/completions. Use /v1/responses or set reasoning_effort to 'none'.
```

Confirmed for luna, terra and sol. `"low"` is rejected too, so on this endpoint
the choice is no reasoning or no tools. `@tailored-ai/provider-openai` posts to
`/chat/completions` and does not map `ChatParams.thinking` to `reasoning_effort`
at all, so **every GPT-5.6 call from TAI currently 400s**. Teaching that plugin
`thinking: off -> reasoning_effort: "none"` is the fix; core already forwards
`thinking` to the provider on every call.

**Codex model ids are mostly gone.** `gpt-5.3-codex` is Responses-API-only
(404 on chat completions); `gpt-5.2-codex` and `gpt-5.1-codex-mini` are
deprecated. `gpt-5.5`, `gpt-5.4` and `gpt-5-mini` work unchanged.

**Anthropic caches only what you mark.** `@tailored-ai/provider-anthropic` used
to place `cache_control: ephemeral` on the last system block and the last tool
definition and nothing else — the correct shape for that API, but only ~23% of a
typical request here (system + tools is roughly 12k of a 45k-token prompt),
against ~86% for a vendor that caches the whole prefix. That alone made Claude
16-30x more expensive per equivalent turn, as a property of the integration
rather than the sticker price.

A third breakpoint now rides on the history, on the second-to-last message so
each turn reads what the previous one wrote, and `promptCaching` defaults to
`true`. Two failure modes to know about: a breakpoint under the minimum
cacheable length (1024 tokens, 2048 for Haiku) is accepted and silently ignored,
and cache writes bill at 1.25x. The plugin skips the breakpoint below the floor
and warns once per model if a marked request reports neither a cache read nor a
write — `cache_creation_input_tokens` is the only evidence either way.

## Failover

`models[]` is an ordered fallback chain, at the deployment level
(`agent.models`) and per agent (`agents.<name>.models`):

```yaml
agent:
  defaultProvider: openai_compatible
  models:
    - provider: openai_compatible   # local vLLM, tried first
      model: qwen3.6-27b-vllm
    - provider: deepseek            # tried when local cannot be built or fails
      model: deepseek-v4-pro
```

Each rung is tried in order. A rung is skipped when its provider cannot be built
(the plugin is not installed), and moved past when its call throws — including
on a 4xx, because "this model refuses this request" is exactly when a different
model is worth trying. The chain is re-resolved every loop iteration, so
installing a plugin and reloading brings a rung to life without a restart.

Precedence, most specific first: an agent's own `models[]`, then its
`model`/`provider` pin (which does **not** opt into the deployment chain — a pin
exists to send that agent somewhere specific), then `agent.models[]`, then a
one-entry chain from `defaultProvider`. A per-call model override never falls
back: naming one model for one call is not a request to be answered by another.

Retry semantics: every rung gets one attempt, and the last also gets the
transient retry that a single-model deployment has always had. Spending a second
and another failed call on a model that just refused, while a working one waits,
is worse than moving on.

**This changes what "no answer" means.** Before, a provider outage failed the
turn; now it fails the turn only when every rung is down. A chain of one behaves
exactly as before.

Two things it deliberately does not do:

- **No quality-based escalation.** It fails over on errors, not on a weak answer.
  Cascading by difficulty or confidence is #173.
- **No per-rung context budget.** `historyBudget` is computed once from
  `maxHistoryTokens` before the call, so falling back to a model with a smaller
  window can produce a request that model rejects — which then falls through to
  the next rung. `ModelEntry.maxContextTokens` is still only read by the
  `/context` display.

Switching the *primary* is still an operator action: flip
`agent.defaultProvider`, or reorder `agent.models[]`.
`scripts/tai-model.mjs use <provider> -i <instance>` does it with a backup.

## Results, and how to read them

All ten candidates called the right tool with the right arguments on a
single-step task, and all ten completed a three-step task (`exec` -> `room` ->
`memory` -> final text) in 3-4 rounds. Tool-calling competence is no longer a
differentiator at this tier; speed, token efficiency and cache behaviour are.

| Model | rounds | wall | out tokens | cache | $/mo* |
|---|---|---|---|---|---|
| gpt-5.6-luna (effort=none) | 4 | 3.5-4.4s | 105-107 | 99% | 20 |
| deepseek-v4-pro (think) | 3 | 5.9-8.1s | 267-305 | 98% | 27 |
| deepseek-v4-pro (no think) | 3 | 4.0-6.1s | 175-178 | 98% | 27 |
| deepseek-v4-flash | 3 | 4.6-5.3s | 186-207 | 98% | 18 |
| gpt-5-mini | 4 | 5.5-6.1s | 234-363 | 68% | 42 |
| minimax-m3 | 3 | 4.8-5.2s | 173-198 | 98% | 39 |
| glm-4.7-flash | 3 | 4.2-5.5s | 184-268 | 0-98% | 7-23 |
| qwen3.7-flash | 3 | 3.9-6.2s | 215-330 | 0-36% | 9-14 |
| qwen3.7-plus | 3 | 8.0-8.8s | 313-331 | 45% | 82 |
| gemini-3.5-flash-lite | 3 | 1.6-2.3s | 99 | 0% | 121 |

\* Against the reference deployment's busy-day rate (12.9M prompt / 0.066M
completion per day). Quiet days there run ~30x lower.

Two cautions about this table:

- **Latency through OpenRouter is not the model's latency.** glm-4.7-flash
  measured 34-43s on one pass and 4-5s on later ones. Judge a model's speed on
  its own API before believing a routed number.
- **A single hard trial is not evidence.** An earlier run of the same test used
  an ambiguous tool result (`has_more: true`, no count) and showed three models
  "failing" to complete. With an unambiguous fixture all three completed in
  three rounds. Run the control before reporting a model as broken.

## Re-measuring

```bash
node scripts/probe-models.mjs            # one-shot tool call, two passes, cache check
node scripts/probe-models.mjs --loop     # multi-round loop with simulated tool results
```

Reads `OPENAI_API_KEY`, `DEEPSEEK_API_KEY` and `OPENROUTER_API_KEY` from the
environment and skips any route whose key is absent. A full sweep costs a few
cents.
