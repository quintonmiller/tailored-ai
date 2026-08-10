# Benchmarking the invocation message

`packages/evals` runs a set of scenarios through the real runtime against a real
model and returns a score. It exists because the wave of changes to the
invocation message ([#418](https://github.com/quintonmiller/tailored-ai/pull/418)
through [#437](https://github.com/quintonmiller/tailored-ai/pull/437)) is exactly
the kind of change unit tests cannot certify: every one of them is individually
pinned, and none of them tells you whether a 27B model still answers in the right
room afterwards.

```bash
pnpm --filter @tailored-ai/evals run eval -- --home ~/.tailored-ai
```

Package reference — scenario format, every assertion, CLI options — lives in
[`packages/evals/README.md`](../packages/evals/README.md). This page is the part
that belongs with the rest of the design notes: what it measures, why it is
shaped this way, and what it cannot tell you.

## What is under test

The **invocation message**: everything TAI assembles and sends on a turn. Six
subsystems contribute to it (`prompt.ts`, `context.ts`, `memory-inject.ts`,
`chat-live-state.ts`, `rooms/watcher.ts`, `load-skill.ts`) and no single place
decides what a turn should contain. See
[context-assembly-design.md](./context-assembly-design.md) for the tier model
those changes were working toward.

The harness never writes an invocation message down. It builds a real
`AgentRuntime` on a throwaway `TAI_HOME`, seeds a real session or real rooms on
the `local` room backend, and runs a real turn — `runAgentLoop` for chat,
`RoomWatcher.pollOnce` for rooms. Whatever core produces is what the model gets.

That is the design constraint everything else follows from: **a benchmark that
restates the prompt stops tracking the code the day someone edits the code.**

## The two kinds of check, and why the split matters

| | Varies with | Trustworthy after |
|---|---|---|
| `prompt_*` — properties of the assembled request | nothing. Same code + same seed = same bytes | one run |
| behavioural — tool calls, room posts, reply text | sampling | several runs |

Prompt checks are cheap certainty. `prompt_occurrences: {text: …, max: 1}` is how
you catch a view block that has started accumulating into the record — the exact
failure that put one 1,115-token check-in prompt into a single session
twenty-three times. `prompt_max_tokens` is a tripwire on scaffolding growth.
Neither needs a good model, or the same model twice.

Behavioural checks are the point, but they are noisy, so the score is a **mean
pass rate over repeats** rather than a pass/fail per scenario. Two-of-three is
not three-of-three, and a benchmark that rounds it away stops noticing a model
becoming less reliable — which is the failure mode that started this.

## Difficulty, and why the overall score cannot answer "where does this stop working"

Every scenario carries a required `difficulty`, 1-5. It is a claim about what
the turn **demands**, never about what it currently scores — grading by observed
pass rate would make the scale circular, because every fix would relabel the
scenario and "we handle the hard ones now" would be true by construction.

| | | |
|---|---|---|
| 1 | reflex | One step, one plausible answer. Failing it means something is broken, not that the question was hard. |
| 2 | routine | A single judgement among near neighbours — which of these tools, whether to speak at all. |
| 3 | composed | Two or more constraints have to hold at once, or a fact has to survive a step to be used in the next. |
| 4 | conflicting | The signals disagree and one has to win, or the right answer is partly a refusal. |
| 5 | frontier | Written at or past the expected ceiling: multi-hop over a long history, a real dependency between agents. |

The benchmark grew by addition, and the overall score averages a regression
tripwire against a scenario written to find the model's ceiling. That average
moves for the wrong reasons — adding six easy rows raises it — and it cannot say
where the wall is. The difficulty rollup can:

```
  1 reflex       ████████████████████ 100%  36/36
  2 routine      ████████████████████ 100%  63/63
  3 composed     ███████████████████░  96%  50/52
  4 conflicting  ███████████████░░░░░  76%  32/42
  5 frontier     ████████░░░░░░░░░░░░  42%  10/24
```

Category tells you which subsystem is weak; difficulty tells you whether the
model is failing the hard half of *every* subsystem, which is a different
finding with a different fix.

`--difficulty` takes `4`, `4+`, `2-3` or `3,5`, and composes with `--filter`:

```bash
pnpm run eval -- --target qwen-local --difficulty 5          # the frontier only
pnpm run eval -- --target qwen-local --difficulty 4+ --filter long-session
```

That is the loop this exists for: run the hard slice, read the failures, write
harder scenarios or file the gaps, repeat until nothing new fails. Running only
the slice is the point — a full cohort is ~23 minutes of GPU and most of it is
re-confirming rows that have passed every time for a month.

**The level is an annotation, not part of what a scenario measures.** It is
excluded from the scenario digest and the per-scenario fingerprints, like
`intent` and `knownGap`, so re-grading a scenario costs nothing. It has to be:
the scale was applied to a set that already existed, the grades are a judgement
that will be revised, and if a re-grade invalidated every published run then
nobody would ever re-grade anything.

## Restraint cases are not filler

Roughly a quarter of the scenarios assert that the agent does **nothing**: passes
on an acknowledgement, answers general knowledge without reaching for a tool,
keeps an answer out of a room it can see but was not asked in.

Without them the benchmark is trivially gamed by an eager model, and eagerness
is the actual production failure — an agent that calls a tool on every turn
scores well on every positive case and is unusable in a room. Each restraint
group also carries an explicit control (`answers-a-direct-question-control`)
because a model that is silent everywhere would otherwise look restrained.

### A scenario must be able to fail on silence

The same trap one level down: **a negative assertion is satisfied by an empty
reply.** `reply_not_matches: /4 million/` is true of a reply that never came, so
a scenario whose only checks are "does not say X" awards a point to an agent
that said nothing.

Seven of 59 were in that state, and one of them was reporting the opposite of
the truth. `says-when-the-front-of-the-conversation-is-gone` scored 3/3 on a
cohort where two of the three passes were `[Agent stopped: max tool rounds
reached]` and `""`. Once the turn actually answered ([#470]), all three runs
confabulated the trimmed number from a prompt that provably does not contain
it — so the scenario had been reporting 100% on a model that fails it every
time.

So a scenario with a reply-based negative check needs `replies: true` beside it,
unless silence is genuinely the right answer — which happens, and should be said
out loud. `does-not-write-the-pass-call-as-text` deliberately has no
`replies: true`: its message is an acknowledgement addressed to nobody, so
declining is correct and silence is what declining looks like. `prompt_*`
negatives are exempt; they are properties of the assembled request, and an
empty reply cannot satisfy them.

Nothing enforces this yet — [#472] proposes a load-time check.

[#470]: https://github.com/quintonmiller/tailored-ai/pull/470
[#472]: https://github.com/quintonmiller/tailored-ai/issues/472
[#478]: https://github.com/quintonmiller/tailored-ai/issues/478

## The failure that shaped the harness

Pointed at a server that accepts connections and never replies, the first version
scored **100%**. `RoomWatcher.runTurn` catches a failed `runAgentLoop`, logs,
advances the cursor and returns — deliberately, so one unprocessable message
cannot burn a room's whole hourly wake budget. The harness saw a turn that
completed, and the request had already been recorded before the call failed, so
every `prompt_*` assertion passed.

The rule now is: no response at all is a failure; one failed call the loop
recovered from is not. Worth stating because it generalises — anything that
records the request before the response can report a green score for an endpoint
that is not there.

## Comparing runs

`compare` is the reason the thing exists. It:

- **says when the two runs did not sit the same exam.** Forty-four scenarios
  against a later fifty-eight shows a score move that is entirely the extra
  fourteen — and the fourteen are never the easy ones. Each report lists the
  scenarios it ran, so this is a comparison of those lists, not of a digest.
- **warns** when the model, endpoint or repeat count differ — that is comparing
  deployments, not code.
- **calls a one-run move noise.** At three repeats one flipped run is 33 points.

Exit code 1 on a real regression, so it can gate something.

`meta.scenarioSetHash` answers the narrower question of whether the scenarios
were *defined* the same way, and is reported separately when the coverage
matches but the digest does not. It is taken over what each scenario puts in
front of the model and what it grades — not over the file bytes, so a comment,
a reflow or a `knownGap` annotation leaves it alone, and a changed assertion
moves it. `meta.scenarioFingerprints` is the same digest per scenario, which is
what turns "something in the set moved" into a list of names — see
[A published result must still describe its scenario](#a-published-result-must-still-describe-its-scenario).

## Published results

Committed reports are compiled into static pages on the docs site at `/bench`:
an index with every published run and a scenario-by-model matrix, and a page per
run with per-category scores and a drill-down into each scenario — its intent,
every check, and for failing runs the reply, the tool calls and the assembled
request.

The pages are built by `packages/site` reading two directories at build time:

| Read from | For |
|---|---|
| `packages/evals/results/*.json` | the current cohort. A record — never edited after the fact. |
| `packages/evals/results/history/*.json` | superseded cohorts, rendered under "Earlier runs". |
| `packages/evals/scenarios/*.yaml` | annotations only, so closing a gap updates every page without re-running anything. |

### The published set is a cohort

`results/baseline-*.json` is **one commit, a clean tree, one run per model**, and
`pnpm run guard:benchmark-cohort` fails the build otherwise. A score is only a
statement about the code if every model answered the same code — the page once
ranked a 44-scenario run above a 58-scenario one because the smaller model had
never sat the harder categories, and neither run's provenance made that visible.

So publishing means re-running **every** model in the list on the same commit.
That is the cost the rule buys, and it recurs: adding a model adds it to every
publish, not once.

### A published result must still describe its scenario

The pages read each scenario's intent and `knownGap` from *today's* files and
pair them with the committed report — deliberately, so closing a gap updates
every page without re-running anything. The cost is that a scenario which keeps
its id and changes what it sends or grades renders an old number under a new
description, and coverage cannot see it, because the id never moved.

That is not hypothetical. `notices-a-truncated-tool-result` was changed to run
`tools: [read]` once its 0% turned out to be the harness measuring its own stub,
and the published 0% stayed on a public page underneath the corrected intent.
The digest had moved — `a971de16862c` → `653357093d26` — and the guard read it
into a variable and never compared it.

Each report now records `meta.scenarioFingerprints`: a digest per scenario it
covered, over the same measured shape as the set hash, so annotating still costs
nothing. A test in the evals package compares them against the current files and
fails with the scenarios named. It lives there rather than in
`scripts/guard-benchmark-cohort.mjs` because it needs the scenario loader and
that guard runs before the build; the two are halves of one rule — the guard
says the published runs share one clean commit, the test says they still
describe the current questions.

Two things it deliberately does **not** flag. A scenario that has since been
*deleted*: the question was withdrawn, the page renders it as absent, and
failing on it would make removing a scenario require a re-run. And a run that
covered only part of the set, which is what makes per-scenario digests better
than the set hash — a `--filter`ed run records the digest of everything it
loaded, so judging it on scenarios it never ran is wrong.

When it fails there are two honest fixes, and the message names both: re-run the
cohort on this commit, or move it to `results/history/`. Re-running says "this
is what the current questions score"; archiving says "we are not publishing a
number for these questions right now". Publishing the stale one says neither.

Superseded cohorts move to `results/history/` rather than being overwritten,
because a model getting better or worse across commits is worth being able to
see and overwriting is the one thing that destroys it. They are deliberately
**not** held to the cohort rule — they record what was true then, including the
parts that were sloppy, and rewriting them to satisfy a rule invented later
would leave no evidence of how the benchmark has changed.

**A run reaches the site by being named and committed.** A plain `eval` writes
`results/<timestamp>-<model>.json`, which `.gitignore` ignores. Renaming it to
`baseline-<something>.json` is the act of publishing it: that prefix is the only
thing the gate looks at, and the deployed site is built by CI from a clean
checkout, so an experiment you never named stays local. A local `next build`
shows your own uncommitted runs, which is the point of running one.

**Merge first, then run.** This repo squash-merges, so a baseline produced on a
PR branch records a `gitSha` that stops existing the moment the PR lands — the
branch commit is squashed away and the branch deleted, and a reader can no
longer check out the code that produced the score. It has already happened once:
the cohort committed in #473 recorded `04409d0`, which is not reachable from
`main`. The number was honest; its provenance was not reproducible, which is the
only reason the field is there.

So when a change touches the scenarios or the runtime: land it, pull `main`, run
the cohort from that clean checkout, and commit the result in a follow-up. The
guard's reachability check is deliberately advisory — a baseline committed
alongside the run that produced it is not yet on `main` — and nothing re-checks
after the merge. [#478] proposes closing that window.

Name a baseline after **what was benchmarked**, since that is the only thing a
reader of a public page can use:

```bash
pnpm --filter @tailored-ai/evals run eval -- --target luna --out results/baseline-gpt-5.6-luna.json
git add packages/evals/results/baseline-gpt-5.6-luna.json
```

The file name is what you called the run and `meta.model` is what actually
answered it; the page shows both, so the two disagreeing is visible rather than
silently reconciled.

Pushing to `main` redeploys the site — `deploy-site.yml` watches
`packages/evals/results/**` as well as the site itself.

### Scenarios that are supposed to be red

A scenario asserting the behaviour we *want* rather than the behaviour we *have*
carries `knownGap`:

```yaml
- id: passes-on-social-chatter
  knownGap: "#447 — whether an unprompted room should suppress chatter is an open question."
```

It renders as a labelled row instead of a failure. Without it the first response
to a permanently-red row is to delete it, which is how a benchmark quietly stops
measuring the thing it was written for. The flag is read from the scenario file,
not the report, so removing it un-marks the row everywhere at once.

## Two agents taking turns

Until #475 every scenario tested **one turn of one agent**: 57 of 59 declared no
second agent, and the two that did used it as scenery. That left the machinery
rooms exist for entirely unmeasured — the wake queue, `minWakeIntervalMinutes`,
`maxWakesPerHour`, pass handling, the per-room FIFO chain. Every one of those
was built in response to a multi-agent failure, and none had a scenario, because
one agent answering once structurally cannot produce a cascade, a silence where
everybody deferred, or a handoff.

`wake:` now takes a list, and each entry may name an agent:

```yaml
  wake:
    - { room: ops, agent: nova }
    - { room: ops, agent: dana }
```

The turns run in order against the same rooms, so a later agent wakes on what an
earlier one posted. Three decisions worth knowing:

- **Subscription follows participation, not declaration.** Only agents that take
  a turn are subscribed. An agent named in `config.agents` and never woken stays
  scenery — subscribing it would put it in the roster of a room it never speaks
  in and change the prompt of every existing scenario that has one.
- **Posts are attributed.** The envelope already carries the speaker, so
  `posts_by` can ask who spoke and how often. `posts_in` cannot: with two agents
  in a room, "somebody posted in ops" is true whether the handoff worked or the
  second agent echoed the first.
- **`reply` is still every body joined**, so a single-agent scenario and every
  reply assertion behave exactly as before.

These scenarios are slower and noisier by construction — more turns, more
sampling per scenario — so they are their own `coordination` category rather
than averaged into a score whose other entries take a single turn.

## What it cannot tell you

- **Nothing about a channel.** Rooms run on the `local` SQLite backend. Discord's
  envelope rendering, webhook identities and rate limits are not exercised.
- **Nothing about tool effects.** Side-effecting tools are stubbed at `execute`,
  so a scenario proves the model *chose* `exec`, never that the command worked.
- **Nothing about long sessions.** Every scenario starts from a seeded history of
  a handful of messages. Compaction, trimming and the 9,000-message sessions that
  motivated the redesign are represented only by their *shape* (a seeded
  `[Earlier conversation summary: …]` block), not their size.
- **No per-scenario cost assertion.** A run reports its tokens and its dollars,
  and `compare` calls out a request that grew — but nothing fails a *scenario*
  for being expensive. `prompt_max_tokens` is the per-scenario tripwire and is
  the right tool for that.

The first and third are the ones worth closing next.

## Cost

Every report carries `meta.usage` (`input`, `output`, and `cacheRead` where the
provider reports one) and `meta.cost` — dollars, plus the per-million rates it
was billed at and the date they were taken.

**Input and output are never summed.** They are priced an order of magnitude
apart, and a single "tokens" figure cannot separate *the prompt got bigger* from
*the model talked more*. Those have opposite fixes, and the first is the thing
this benchmark exists to catch.

Three rules worth knowing, because each one is a way the number could lie:

- **A model with no price shows tokens and no dollars.** `cost.ts` holds a small
  table keyed by model id (longest-prefix match, so `gpt-5.6-2026-07-01` keeps
  `gpt-5.6`'s rates). Locally-served models are deliberately absent rather than
  priced at 0 — zero renders as "free", and the GPU-hours are real.
- **Money is recorded, never recomputed.** The CLI prices a run when it writes
  it, and every other surface displays that. Otherwise the site and the terminal
  can disagree about a bill. It also means an old run keeps the rates it was
  actually billed at: adding a price today does not retroactively price last
  month's run, which would be inventing a measurement.
- **A cached read replaces the uncached charge, it does not add to it.**
  Providers report `cached_tokens` as a *subset* of `prompt_tokens`. Charging
  both double-counts the request and gets the sign backwards, making a run that
  cached well look dearer than one that cached nothing.

Tokens *do* backfill: `totalUsage` falls back to summing the runs, so every
report written before `meta.usage` existed reads correctly without being
re-run. The per-run numbers were always there; only the total was missing.

`compare` reports a request-size move above 5%, per run so it survives a
differing repeat count, and stays silent across different models — where a token
difference is tokenizers and verbosity, not code.

## Effort — the axis that keeps moving after the score stops

A pass rate saturates. Once everything passes it has nothing left to say, and
this set is already at 92.7%. So every run also reports what being right cost:

```
per run    1 rounds, max 7 · 1 tool calls, max 11 · 16.7s latency, max 3m 03s   (median)
```

**Median and max, never a mean.** The current cohort has 78 runs that make no
tool call and two that make eleven; a mean says 1.4 and describes no run that
happened. The gap between median and max *is* the tail, which is the part worth
looking at.

Nothing new is measured — every field was already in every report. `latencyMs`
and `usage` are per run, `calls[]` is per run, and there is one `requests[]`
entry per model round: `worker.ts` blanks the prompt text of a passing run but
keeps the entry. So old reports read correctly without being re-run.

`compare` diffs **rounds and tool calls** per run, with the same guards as the
token move — silent across different models, and per run so a differing repeat
count is not a finding — plus an absolute floor of half a unit, because 0.02 →
0.04 tool calls per run is a 100% move and half a call across the whole set.

**Latency is deliberately not compared.** It is dominated by what else was on
the GPU: the same 59 scenarios took 20 minutes on a quiet box and over two hours
beside a competing job. A diff of it would report the machine, not the change.
It is printed, where a reader has the context to judge it; it is not a
regression signal.

Two per-scenario tripwires make effort *fail* a scenario rather than only
appear next to it, the way `prompt_max_tokens` already does for request size:

| | |
|---|---|
| `max_rounds` | model round-trips this turn may take |
| `max_tool_calls` | tool calls it may make — calls, not distinct tools, since a turn that retries the same lookup twice cost what it cost |

## Running it against a deployment

`--home <dir>` reads that instance's endpoint, model, temperature, `maxTokens`,
`providerExtra` and reasoning dialect out of its `config.yaml`. It reads nothing
else and writes nothing back — the run still happens on a temp home with its own
database.

This is what makes the repetition scenarios meaningful. `repetition_penalty` is a
vLLM control core does not model, reachable only through `agent.providerExtra`
(see [agent-loop.md](./agent-loop.md#sampling-controls-core-does-not-model-providerextra)).
Run without `--home` and those scenarios are the first to fail, correctly.

One command per deployment, wherever its `TAI_HOME` is:

```bash
pnpm --filter @tailored-ai/evals run eval -- --home ~/.tailored-ai --out results/qwen-local.json
pnpm --filter @tailored-ai/evals run eval -- --home /srv/tai       --out results/qwen-server.json
```

Comparing those two compares *models and sampling*, not code — `compare` says so
in a warning rather than leaving you to remember it.
