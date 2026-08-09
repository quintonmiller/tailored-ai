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

## Restraint cases are not filler

Roughly a quarter of the scenarios assert that the agent does **nothing**: passes
on an acknowledgement, answers general knowledge without reaching for a tool,
keeps an answer out of a room it can see but was not asked in.

Without them the benchmark is trivially gamed by an eager model, and eagerness
is the actual production failure — an agent that calls a tool on every turn
scores well on every positive case and is unusable in a room. Each restraint
group also carries an explicit control (`answers-a-direct-question-control`)
because a model that is silent everywhere would otherwise look restrained.

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
moves it.

## Published results

Committed reports are compiled into static pages on the docs site at `/bench`:
an index with every published run and a scenario-by-model matrix, and a page per
run with per-category scores and a drill-down into each scenario — its intent,
every check, and for failing runs the reply, the tool calls and the assembled
request.

The pages are built by `packages/site` reading two directories at build time:

| Read from | For |
|---|---|
| `packages/evals/results/*.json` | the runs. A record — never edited after the fact. |
| `packages/evals/scenarios/*.yaml` | annotations only, so closing a gap updates every page without re-running anything. |

**A run reaches the site by being named and committed.** A plain `eval` writes
`results/<timestamp>-<model>.json`, which `.gitignore` ignores. Renaming it to
`baseline-<something>.json` is the act of publishing it: that prefix is the only
thing the gate looks at, and the deployed site is built by CI from a clean
checkout, so an experiment you never named stays local. A local `next build`
shows your own uncommitted runs, which is the point of running one.

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

## What it cannot tell you

- **Nothing about a channel.** Rooms run on the `local` SQLite backend. Discord's
  envelope rendering, webhook identities and rate limits are not exercised.
- **Nothing about tool effects.** Side-effecting tools are stubbed at `execute`,
  so a scenario proves the model *chose* `exec`, never that the command worked.
- **Nothing about long sessions.** Every scenario starts from a seeded history of
  a handful of messages. Compaction, trimming and the 9,000-message sessions that
  motivated the redesign are represented only by their *shape* (a seeded
  `[Earlier conversation summary: …]` block), not their size.
- **Nothing about cost.** Token usage is recorded per run but nothing asserts on
  it beyond `prompt_max_tokens`.

The first and third are the ones worth closing next.

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
