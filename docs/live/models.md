# Which model plays, and what it costs to never stop

All prices verified 2026-08-13 against the AWS Price List API bulk offer for
`AmazonBedrock` (publication `2026-08-11T16:17:54Z`), `us-east-1`, standard
service tier, unless a row says otherwise. Anything I could not verify from a
primary source is marked **unverified** rather than filled in.

## The workload, as a bill

One measured run of the current 40-round configuration:

| | |
|---|---|
| wall clock | 27–38 min |
| input tokens | 5.8–6.5M |
| output tokens | 56–76k |
| model calls | ~200 (5 agents × 40 rounds) |
| **mean input per call** | **~31,000 tokens** |
| input : output | **~100 : 1** |

Running back-to-back, that is **~11M input and ~120k output tokens per hour**,
or **~8.0B input and ~86M output tokens in a 30-day month**.

Three consequences, and they dominate every other consideration in this
document:

1. **Output price is nearly irrelevant.** At 100:1, a model that halves its
   output price saves under 1% of the bill. Rank on input price.
2. **The bill is a function of wall-clock, not of run count.** Longer runs
   (`startFloor: 1`, ~150 rounds, ~3 hours) do not cost more per hour than short
   ones. Choosing a longer, more watchable format is free.
3. **31,000 input tokens per call is the actual cost driver, and it is a
   configuration choice, not a law.** See [Cut the prompt before you cut the
   model](#cut-the-prompt-before-you-cut-the-model) — it is worth more than any
   model swap short of the very cheapest tier.

## Caching on Bedrock is narrower than you'd expect

This is the finding that reshapes the shortlist. Searching every prompt-cache
SKU in the price list returns **six model families**:

```
Nova2.0Lite  NovaLite  NovaMicro  NovaPro  NovaPremier  xai.grok-4.3-mantle
```

**No Qwen, Nemotron, gpt-oss, Gemma, GLM, Kimi, MiniMax, DeepSeek, Mistral or
Llama model has a cache SKU.** For those families the headline input price is
the price you pay on every token of every resent history — there is no lever.

Claude does support caching on Bedrock, and the ratios are the familiar ones.
The only Claude cache prices exposed anywhere machine-readable are the legacy
3.5 Sonnet v2 rows on the pricing page:

| | per M tokens | ratio to input |
|---|---|---|
| input | $6.00 | 1.00× |
| cache write | $7.50 | 1.25× |
| cache read | $0.60 | **0.10×** |

Nova's shape is different and, for this workload, unusually good:

| Nova 2 Lite (global cross-region) | per M tokens |
|---|---|
| input | $0.30 |
| cache **write** | **$0.00** |
| cache read | $0.075 (0.25×) |
| output | $2.50 |

### The hit rate this workload should achieve

Each agent holds its own conversation. Between agent A's turn in round *N* and
its turn in round *N+1*, four other agents act — roughly 40–50 seconds. That is
inside the 5-minute cache TTL, so every one of A's turns should read the whole
of its previous prompt from cache and write only the delta: the last assistant
turn plus the tool results.

With ~31k tokens per call and a few thousand tokens of new content per turn, an
**85% read rate** is the conservative planning figure. That gives:

| family | effective input rate | saving |
|---|---|---|
| Claude (0.10× read, 1.25× write) | `0.85×0.10 + 0.15×1.25` = **0.27×** | 73% |
| Nova (0.25× read, free write) | `0.85×0.25 + 0.15×1.00` = **0.36×** | 64% |
| everything else | 1.00× | none |

Verify it rather than assuming it: Bedrock returns `cacheReadInputTokens` on
every response, and a run whose cache reads are zero has a silent invalidator in
the prompt — a timestamp, a re-ordered tool list, a per-turn header. The harness
should log the ratio per run and the site should show it, because it is the
single number that says whether the bill is under control.

## The shortlist

Ranked by monthly cost at full 24/7, which is the same as ranking by input
price. Tool-calling verdicts are **judgements, not measurements** — see
[Qualifying](#qualifying-a-model-before-it-gets-airtime) for how to replace them
with numbers cheaply.

| # | Bedrock model | in $/M | out $/M | cache | **$/month 24/7** | tool calls |
|---|---|---|---|---|---|---|
| 1 | `nvidia.nemotron-nano-3-30b` | 0.06 | 0.24 | none | **$500** | small model, unproven at 20+ tool schemas |
| 2 | `amazon.nova-lite-v1` | 0.06 | 0.24 | yes | **$500** (cached ~$310) | Converse tool use is solid; reasoning is the limit |
| 3 | `openai.gpt-oss-20b` | 0.07 | 0.30 | none | **$590** | usable; expect malformed calls under pressure |
| 4 | `google.gemma-3-12b-it` | 0.09 | 0.29 | none | **$745** | weakest tool discipline of the group |
| 5 | `openai.gpt-oss-120b` | 0.15 | 0.60 | none | **$1,250** | good; the cheapest model I'd expect to hold 20 schemas |
| 6 | `qwen.qwen3-32b` | 0.15 | 0.60 | none | **$1,250** | closest sibling to the 27B already measured at 89–92% |
| 7 | `nvidia.nemotron-super-3-120b` | 0.15 | 0.65 | none | **$1,255** | large, instruction-tuned; untested here |
| 8 | `google.gemma-3-27b-it` | 0.23 | 0.38 | none | **$1,875** | mid |
| 9 | `amazon.nova-2-lite-v1` (global) | 0.30 | 2.50 | yes | **$2,615** (cached **~$1,090**) | current-gen Nova; caching makes it competitive |
| 10 | `anthropic.claude-haiku-4-5` | 1.00 | 5.00 | yes | $8,430 (cached **~$2,590**) | reliable tool calls; the cheapest model I'd trust unattended |

For scale, the tiers above the shortlist:

| model | in / out $/M | uncached $/mo | cached $/mo |
|---|---|---|---|
| `anthropic.claude-sonnet-5` | 3.00 / 15.00¹ | $25,300 | **~$7,800** |
| `anthropic.claude-opus-5` | 5.00 / 25.00 | $42,150 | **~$13,000** |

¹ $2 / $10 promotional through 2026-08-31, then $3 / $15
([AWS](https://aws.amazon.com/bedrock/pricing/), checked 2026-08-13). Modern
Claude models have **no SKUs in the machine-readable price list at all** — only
Claude 2.0/2.1/Instant/3 Haiku/3 Sonnet appear. These two rows come from the
rendered pricing page and Anthropic's list prices, and both should be
re-confirmed before anyone commits a budget to them. **Unverified.**

### Two prices that are not on the shortlist but should be known

- **Regional endpoints cost 10% more than global** on Bedrock. Nova 2 Lite is
  $0.33 in-region and $0.30 global. Use the global endpoint unless a data
  residency rule says otherwise; it is also the more available one.
- **Flex tier is exactly 0.50× standard and Priority exactly 1.75×**, verified
  across all 41 models carrying tier SKUs. Flex halves the bill — but **no
  Claude model has a Flex or Priority SKU**, and Flex is a lower queue priority
  with longer, unbounded processing times. For a live show, a model call that
  takes four minutes stalls the broadcast. Flex is right for the *held-out*
  arena, which nobody is watching, and wrong for the live one. That split alone
  is worth about 25% of the model bill.

## The recommendation

**Primary: `qwen.qwen3-32b` at ~$1,250/month.** It is the nearest available
sibling to the 27B model that produced the only tool-correctness numbers this
benchmark has (89% and 92%), which makes its results continuous with everything
measured so far rather than a fresh baseline. That continuity is worth more than
a few hundred dollars.

**Cheap fallback: `amazon.nova-lite-v1` at ~$310/month cached.** Runs the show
during a budget squeeze, and — because Nova is one of the six families with a
cache SKU — it is the only cheap option where the caching lever exists at all.

**Aspirational: `anthropic.claude-haiku-4-5` at ~$2,590/month cached.** The
cheapest model I would leave calling twenty tool schemas unattended for a month.

**The mixed fleet is a trap, with one exception.** Running different models on
different party members is the most obviously fun idea in this document and it
destroys the measurement: a run's score stops attributing to any model, the
ladder comparison becomes meaningless, and every diagnostic reads as a property
of a chimera. Do it *only* as an exhibition run, clearly labelled, never ranked
— see the ranked/exhibition split in [README.md](./README.md).

The exception is the narrator, which is not a player: it observes, it cannot
affect the run, and it is the voice of the broadcast. A better model there
improves the show without touching the benchmark. It costs almost nothing —
one call per round boundary against a compact digest, perhaps 2k tokens in and
100 out, so **under $30/month even on Sonnet 5**. Spend there.

## Cut the prompt before you cut the model

At 31,000 input tokens per call, the request is mostly conversation history.
Halving what gets resent halves the bill, on any model, with no change in
provider and no loss of comparability against future runs — provided the change
is made once, recorded in the run fingerprint, and applied to every ranked run
in a season.

Ordered by value:

| lever | effect on the bill | cost to build |
|---|---|---|
| Bounded history window per agent | proportional — a 31k→10k cut is **−68%** | small; the harness already compacts |
| Prompt caching where the family supports it | −64% to −73% | small; a `cache_control` breakpoint on the stable prefix |
| Flex tier for held-out / non-broadcast runs | −50% on those runs | trivial: one request parameter |
| Trim tool schemas | a 41-tool deployment spends ~10,900 tokens on schemas alone | small, and improves tool correctness |
| Scripted-baseline runs as filler content | −100% for those hours | already built (`eval rehearse`) |
| Duty cycle: 16h/day instead of 24 | −33% | a cron and a holding card |

The last one deserves a straight answer: **24/7 is a branding decision, not a
technical one**, and it costs a third more than a channel that runs 16 hours a
day. A show that goes dark overnight and comes back is not obviously worse
television. Decide it deliberately.

## Bedrock operations at this duty cycle

### Quotas

The workload is small in Bedrock terms. 8,000 calls/day at ~31k tokens is
roughly **5.5 requests/min and 170k tokens/min** — comfortably inside every
shortlisted model's quota. For reference, from the AWS General Reference table
(checked 2026-08-13):

| model | RPM | TPM |
|---|---|---|
| Qwen3 32B (and most open-weight models) | 10,000 | 100,000,000 |
| Nova Lite, cross-region | 4,000 | 8,000,000 |
| Claude Haiku 4.5, cross-region | 10,000 | 5,000,000 |

Four things about quotas that are not obvious:

- **On-demand single-region TPM is marked non-adjustable** for every model.
  Cross-region (CRIS) TPM is adjustable and is exactly **2× the single-region
  number** — so using a cross-region inference profile doubles the ceiling
  before you ask anyone for anything.
- Most current-generation Claude models **have no single-region quota row at
  all** — they are cross-region-profile-only. The `us.` prefix is not a
  preference, it is how you reach them.
- **Output tokens burn quota at a multiplier**: 5× for Claude models up to 4.7,
  10× for Sonnet 5 and Opus 5, 15× for Opus 4.8, 1:1 for everything
  non-Anthropic. Irrelevant at 100:1 input ratio, but it changes what a headline
  TPM figure means.
- Quota is deducted at request start as `input + max_tokens` and reconciled
  afterwards. An inflated `max_tokens` reserves quota the run never uses. The
  harness sets 8,192; that is fine, but do not raise it casually.

### The tiers that do not apply

- **Provisioned Throughput is not an option for modern Claude.** The supported
  list stops at Claude 3.5 Sonnet v2 (Oct 2024). Nothing newer has a PT entry.
- **The Reserved tier** (99.5% uptime target, 1 or 3 month commitment, minimum
  100k input TPM / 10k output TPM) exists only for the Claude 4.5 family and is
  gated behind an AWS account team. Our steady-state need is 170k TPM, so the
  minimum is not absurd — but the price is unpublished, and committing to a
  month of reserved capacity for a show that might not find an audience is the
  wrong shape of risk at launch.
- **Batch is unusable.** It is 50% off and completely inapplicable: the
  simulation is a turn loop where turn *N+1* depends on turn *N*'s result. There
  is nothing to batch.

### What happens when it throttles

A `ThrottlingException` mid-run is the most likely routine failure. The
supervisor must treat it as back-off-and-retry, not as a failed run — a run
abandoned at round 25 is a wasted 25 rounds of tokens and a hole in the
broadcast. Retry with jitter, and if throttling persists past a threshold, fall
back to a baseline-bot rehearsal on air rather than dead-airing.

## Qualifying a model before it gets airtime

Every tool-calling verdict in the table above is a guess. Replacing them costs
about **$5 per model**:

1. Three ranked runs on a fixed seed at the current configuration (~$0.30–$4.00
   of tokens each depending on tier).
2. Read three numbers the harness already reports: tool-call correctness,
   earned experience against the `basic-tactics` rung, and survivors.
3. **Disqualify below 85% tool correctness.** Below that the model is not
   playing the game, it is failing to address it, and a month of airtime will
   show a party standing still.

Do this before every season and publish the results. It is cheap, it is the
kind of number the audience for this project actually wants, and it converts the
weakest section of this document into data.

## Not Bedrock

A sanity check, because the repo already carries provider plugins for
OpenAI-compatible endpoints, OpenRouter, DeepSeek and Anthropic direct.

| route | ~$/month at this workload | note |
|---|---|---|
| Bedrock, cheap open-weight | **$500–1,250** | quotas, IAM and billing already in the same account as the rest of the stack |
| DeepSeek direct | comparable to Bedrock's `deepseek.v3.2` at $0.62/M in → ~$5,000 | its own caching discount is the variable; **unverified** |
| OpenRouter | a routing fee over whichever provider it picks | adds a second point of failure to a 24/7 show |
| Self-host on a GPU instance | **$730–1,500** for a `g6.xlarge`-class box before storage and ops; **unverified**, EC2 prices not confirmed | |

Self-hosting is the option people assume wins at a continuous duty cycle,
because you stop paying per token and start paying per hour. At these Bedrock
prices it does not: a single always-on GPU instance costs about the same as
`qwen3-32b` on Bedrock and brings model serving, model updates, GPU failure and
a second thing to monitor at 3am into a one-person operation. **It only becomes
attractive if the token spend rises well past $1,500/month** — which happens if
the format moves to a frontier model, not if it stays on this shortlist.

## Keeping the bill visible

| control | what it does |
|---|---|
| AWS Budgets alert at 50 / 80 / 100% of a monthly ceiling | free; the basic monitoring tier has no charge |
| A hard stop in the supervisor at a per-day token count | the only control that acts without a human |
| Per-run cost recorded in the trace | the run summary already carries `usage.input` / `usage.output` and a null `cost` field — populate it |
| Cache-read ratio logged per run | catches a silent cache invalidation before it becomes a 4× bill |
| A kill switch reachable from a phone | see [security.md](./security.md) |

The per-run cost figure is worth building even though it is bookkeeping: it
makes the show's economics legible to the audience, and "this run cost $0.42"
is a genuinely interesting number to put on screen next to the score.
