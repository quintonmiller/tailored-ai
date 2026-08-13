# Taking The Endless Descent live

A plan for running the benchmark continuously on rented hardware, in public, as
something people can watch.

> The benchmark itself is [docs/endless-descent.md](../endless-descent.md); the
> page being broadcast is [docs/broadcast-viewer.md](../broadcast-viewer.md).
> This directory is about everything between "it runs on a laptop" and "it runs
> forever, on television, and nobody has to be awake for it."

| document | what it decides |
|---|---|
| [models.md](./models.md) | which model plays, what it costs to run one 24/7, and how caching changes that |
| [infrastructure.md](./infrastructure.md) | the box, the run supervisor, deploys, storage, alarms |
| [website.md](./website.md) | the public site, how live data reaches viewers, what it costs at scale |
| [streaming.md](./streaming.md) | headless capture → encode → Twitch, and how to make a slow show watchable |
| [security.md](./security.md) | the real trust boundary, the write path, and what data is public |
| [branding.md](./branding.md) | the name, the seasons format, community, and the social plan |

## The shape of the thing

Five model-driven agents descend a dungeon that cannot be won, until they die.
The run is scored on what they earned before dying, and the score only means
something read against a ladder of six scripted parties that never call a model
at all.

That ladder is the product. A hundred lines of if-statements score 29,007. The
agent party scores 6,550 and gets everybody killed. **Everything downstream —
the site, the overlay, the pitch — leads with that comparison rather than with
the dungeon**, because the dungeon is a device and the comparison is the result.

Four numbers set every constraint in these documents:

| | |
|---|---|
| one run | 27–38 minutes, ~200 agent turns |
| one run's tokens | 5.8–6.5M in, 56–76k out — roughly **100:1** |
| pace on screen | one agent action every **8–11 seconds** |
| runs per day, continuous | ~40 |

The 100:1 ratio makes prompt caching the dominant cost lever, not model choice —
see [models.md](./models.md). The 8–11 second pace makes this an ambient channel
in the shape of a chess stream, not a game stream — see
[streaming.md](./streaming.md).

## What it costs

Three configurations, all running 24/7. Every figure is derived in the document
that owns it; prices checked 2026-08-13.

| | lean | recommended | premium |
|---|---|---|---|
| Model tokens ([models.md](./models.md)) | $310 `nova-lite`, cached | $1,250 `qwen3-32b` | $2,590 `claude-haiku-4-5`, cached |
| Infrastructure ([infrastructure.md](./infrastructure.md)) | $255 | $255 | $255 |
| Narrator voice ([streaming.md](./streaming.md)) | $9 Polly Standard | $70 Polly Neural, selective | $70 |
| Narrator model | $10 | $30 | $30 |
| **Total / month** | **~$585** | **~$1,605** | **~$2,945** |

Two numbers inside that are worth pulling out because they are counter-intuitive:

- **The stream's outbound bandwidth is $90/month** and is the second-largest
  infrastructure line after compute. Dropping from 1080p60 at 6,000 kbps to
  1080p30 at 3,500 kbps saves $68/month and *improves* the picture for viewers
  who get no transcodes — because the content is static text, which is the
  easiest thing a codec ever compresses.
- **A frontier model is not on the table.** Claude Sonnet 5 at this duty cycle is
  ~$7,800/month even with caching, Opus 5 ~$13,000. The show runs on a cheap
  model or it does not run. That is not a compromise to apologise for: the
  measurement's whole point is the ladder, and a cheap model losing to a scripted
  bot is the same result as an expensive one losing to a scripted bot, for a
  twentieth of the price.

The single largest lever on the bill is not the model. It is that each call
carries ~31,000 input tokens of conversation history — bounding that window
would cut the token bill by roughly two thirds on any model.

## Decisions

### Ranked runs and exhibition runs are different things, and the screen says which

The benchmark's founding rule is that a run's numbers are identical whether or
not anybody is watching. That rule survives contact with a laptop easily and
contact with a 24/7 channel badly: the show wants variety, longer arcs, novel
party compositions and new content, while the measurement wants pinned versions,
fixed budgets and repeats.

Declare both classes and label them on screen:

| | ranked | exhibition |
|---|---|---|
| model + version | pinned for the season | anything |
| scenario fingerprint | pinned | anything |
| round budget | fixed | anything |
| repeats | 3+ per configuration | 1 |
| enters the leaderboard | yes | never |
| what it's for | the result | the television |

Ranked runs stay untouched, so the integrity rule holds where it matters.
Exhibition runs are where new content, split parties and model mashups get aired
before they are measured. `results/rehearsals/` already models exactly this
separation for bot runs and is deliberately outside the scoreboard's reach —
extend that mechanism rather than inventing a second one.

### The supervisor is the first thing built, and it does not exist yet

`eval run` executes a batch and exits. Everything about running forever — pick a
seed, start a run, notice it wedged, publish the trace, back off when Bedrock
throttles, start the next one, never wedge itself — is unwritten. It is the
single largest piece of new code in this plan and the only one that blocks every
other phase. [infrastructure.md](./infrastructure.md) specifies it.

### Publication contaminates the benchmark, so hold half of it back

A public benchmark with published traces is a benchmark that future models train
on. This is not hypothetical and it is the objection any ML reader will raise
first.

Run each season in two halves: a **public arena** whose traces, seeds and
diagnostics are published in full, and a **held-out arena** with different seeds
and some unpublished content, run on the same cadence and reported only as a
score. If the two ever diverge, that divergence is the contamination, measured —
which is a more interesting result than the benchmark it damages. Say this out
loud in the launch material rather than waiting to be asked.

### Cost ceiling before the first token

The most likely way this becomes expensive is a loop that never stops calling a
model, at 3am, unattended. A hard budget, an alarm and a kill switch are phase 0
work, not hardening — see [security.md](./security.md) and
[models.md](./models.md).

## Build order

Each phase is useful on its own and none of them require the next one.

| phase | what exists at the end | gate to move on |
|---|---|---|
| **0 — headless** | one run completes unattended on a rented box against a remote model, with a spend ceiling and an alarm | a run finishes with nobody logged in, and the bill matches the estimate |
| **1 — endless** | the supervisor loops runs indefinitely, publishes traces, survives a throttle and a crash | 72 hours unattended with no manual intervention |
| **2 — public** | the site is live and read-only, the archive replays past runs, the ladder is on the front page | someone with no context understands what they are looking at in ten seconds |
| **3 — broadcast** | Twitch, 24/7, with a holding card for gaps and a kill switch | a week live with under an hour of dead air |
| **4 — a show** | narration voice, milestone alerts, chat ingest, clips pipeline | the failure-clip format is repeatable without hand editing |
| **5 — a season** | leaderboard across several models, season 1 closed and reported | the write-up stands up to an ML audience |

Phases 0 and 1 are worth doing even if the rest is abandoned: they are what turn
a benchmark you run by hand into one that produces results while you sleep.

## Gaps in the brief

The requirements covered hosting, models, the site, the stream, safety and
branding. These are the things that will bite anyway.

**The show has no idle content.** An endless format still has gaps — between
runs, during a deploy, when Bedrock is down. Dead air on a 24/7 channel is worse
than no channel. Decide what plays: a holding card, a replay of the best run so
far, or the scripted baselines playing live, which costs nothing and quietly
reinforces the ladder. [streaming.md](./streaming.md) picks one.

**Content depth is sized for a run, not for a season.** Ten enemy families and
four bosses across 756 lines of content is enough for a run that ends in the
thirties, and thin for a viewer in their fourth hour. A content pipeline — new
families, new hidden mechanics, a deeper floor rotation — is a recurring cost of
running this in public, and new content must be aired as exhibition before it
becomes ranked.

**Comparability depends on pinned model versions, and vendors move.** The run
metadata already carries a `pinnedAt` timestamp; a season's ranked results are
only comparable if the model version behind them is fixed and recorded, and if a
deprecation mid-season is treated as an event that ends a season rather than
something to paper over.

**Nobody is awake for two thirds of it.** An unattended channel broadcasting
model-generated text needs a moderation answer that is not "a person watches" —
a delay, an automated first pass, and a kill switch that anyone trusted can
reach from a phone. [security.md](./security.md) owns the policy,
[streaming.md](./streaming.md) the mechanism.

**The leaderboard is the only irreplaceable artefact.** Traces regenerate;
records do not. It needs a backup story separate from the box.

**Credibility requires reproducibility.** This is a self-published leaderboard.
Publish enough — seed, model version, scenario fingerprint, the harness commit —
that a stranger can re-run a record and get the same number. That is also
exactly what the held-out arena exists to protect, so the two policies have to
be written together.

**Handles before announcements.** Register the domain and every platform handle
before the name appears anywhere public, including in this repo's history.

**Ingesting Twitch chat makes you a processor of other people's data.** If real
chat is displayed and stored alongside traces, it needs a retention and deletion
policy that trace data does not.

**Accessibility.** The broadcast page is a canvas, and canvas is invisible to a
screen reader. The site needs a text path to the same information — which the
trace already is, so this is cheap if it is designed in and expensive if it is
retrofitted.

**No kill criterion.** Decide now what "this did not work" looks like at 90 days
and what happens then, while the decision is cheap and unemotional.

## Three things that block work, and one to fix in passing

**Can the eval harness reach Bedrock at all today?** The repo ships a
`@tailored-ai/provider-bedrock` plugin, and the evals package lists provider
plugins for Anthropic, DeepSeek, OpenAI and OpenRouter in its dev dependencies —
Bedrock is not among them. Whether `eval run` can target Bedrock with a config
change or needs plugin wiring is **unverified**, and every cost figure in
[models.md](./models.md) assumes it can. This is an hour of work to answer and it
gates phase 0.

**The theme direction is undecided and it blocks the site, the overlay and the
brand.** [endless-descent-improvements.md](../endless-descent-improvements.md)
§2 has three rendered directions waiting on a choice, and the honest note there
is that the page currently reads as "the house style of an internal admin tool".
[branding.md](./branding.md) picks one; that pick should be ratified before any
frontend work starts, because it is the difference between a paint job and a
rewrite.

**Mobile is where the audience arrives and the page cannot reflow.** The
broadcast view is a fixed 16:9 three-column dashboard. Traffic referred from a
Twitch stream is overwhelmingly phone traffic, and it lands on a layout that
does not work. This is the single largest piece of frontend work in the plan and
it is easy to discover late.

**One line to fix before it ships:** the scenario's opening room message is
attributed to a speaker named after a real person. The repo's own conventions
require examples to use role names, because example text spreads by copy-paste —
and this particular example is about to be broadcast. One word, easier now.
