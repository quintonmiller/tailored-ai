# @tailored-ai/evals

A scenario benchmark for the **invocation message** — the request TAI assembles
and sends to a model on every turn.

It is not a unit test suite. Unit tests pin the assembly; this measures whether a
real model, given that assembly, does the right thing: answers in the room that
asked, declines when it has nothing to say, picks the tool that fits, and does
not re-emit its own last message. Those are the properties a prompt change can
break without failing a single test.

```bash
pnpm --filter @tailored-ai/evals run eval -- --home ~/.tailored-ai
pnpm --filter @tailored-ai/evals run eval:compare -- results/before.json results/after.json
```

## What a run does

For each scenario, in its own process, on a throwaway `TAI_HOME`:

1. write a `config.yaml` and load it through the real `loadConfig`
2. construct a real `AgentRuntime` — real tools, real prompt assembly
3. seed a real session, or real rooms on the `local` room backend
4. run a real turn: `runAgentLoop` for chat, `RoomWatcher.pollOnce` for rooms
5. record every request, every tool call, and everything the agent posted
6. grade against the scenario's `expect:` list

Nothing about the invocation message is written down here. It is whatever core
produces, which is what makes the benchmark track code changes without anyone
updating it.

Three things are deliberately not real:

| | |
|---|---|
| the home | a fresh temp dir per run — no deployment's config, database or context files are touched |
| side-effecting tools | `exec`, `read`, `write`, `web_fetch`, `notify_owner`, `delegate` and friends keep their real name, description and schema, but their `execute` returns a canned string. Tool *selection* is under test; tool *effects* are not. |
| streaming | the recording provider exposes `chat` only, so the loop takes the blocking path. Same request body. |

`room`, `schedule`, `tasks`, `recall` and `core_memory` run for real — they only
touch the throwaway database, and a scheduling scenario that stubs `schedule`
tests nothing.

## The score

A **mean pass rate over runs**, not a count of passing scenarios. A scenario that
passes two runs in three is genuinely different from one that passes three, and
rounding that to "pass" is how a benchmark stops noticing a model getting less
reliable. Default 3 repeats; each repeat uses `seed + i`, so a run is
reproducible across invocations and still varied within one.

Two families of check, and the split matters:

- **`prompt_*`** — properties of the assembled request. No model variance at all:
  same code, same seed, same bytes. These are the part of the score that means
  something after a single run, and the first place to look when a comparison
  shows a drop.
- **everything else** — properties of what the model did. Stochastic, which is
  why scenarios repeat.
- **`judge`** — an LLM reading the reply against a rubric. Noisiest of the three,
  off unless `--judge`, and no shipped scenario uses one.

### A run that got no answer is a failure

The room path catches a failed turn on purpose — one unprocessable message must
not burn a room's whole hourly wake budget — so a dead model looks to the harness
like a turn that completed and said nothing. Pointed at a server that accepts and
never replies, an early version of this benchmark scored **100%**: the request had
been assembled and recorded before the call failed, so every `prompt_*` check
passed. A run where no call came back is now reported as a failure with the cause,
and `--timeout` bounds each call so one wedged request cannot stall the batch.

## Writing a scenario

```yaml
- id: relays-to-another-room-with-the-tool
  category: addressing
  difficulty: 3                 # 1 reflex … 5 frontier. Required. See below.
  intent: Asked in one room to tell someone in another, it has to use the tool.
  agent:
    name: nova
    instructions: "You are Nova, a calm and practical assistant."
    tools: [room]
  config:                       # merged over the fixture config
    rooms:
      crossRoomView: { enabled: true, messages: 24, floorPerRoom: 2 }
  rooms:
    - name: ops
      seen:                     # posted, then the cursor jumps past them
        - { speaker: quinton, body: "morning" }
      incoming:                 # posted after arming — this is the wake
        - { speaker: quinton, to: [nova], body: "tell dana in design we're unblocked" }
    - name: design
      seen:
        - { speaker: dana, body: "still waiting on the icon export" }
  wake: { room: ops }
  expect:
    - calls_tool: room
    - tool_args: { tool: room, where: { action: post, room: "/design/" } }
    - posts_in: design
```

A chat scenario uses `message:` and optional `history:` instead of `rooms:`.
Speakers not declared as agents become people automatically; declare another
agent by adding it under `config.agents`.

### More than one agent

`wake:` also takes a **list**, and each entry may name an agent. The turns run
in order against the same rooms, so a later agent wakes on what an earlier one
posted:

```yaml
  wake:
    - { room: ops, agent: nova }
    - { room: ops, agent: dana }
```

Only agents that take a turn are subscribed to the rooms. An agent declared in
`config.agents` and never woken is scenery — it exists so the transcript can
show a third party — and subscribing it would put it in the roster of a room it
never speaks in, changing the prompt of every scenario that has one.

`posts_by` is the assertion this needs. `posts_in` asks whether anything landed
in a room, which with two agents is true whether the handoff worked or the
second one echoed the first.

Every `expect` entry carries **exactly one** assertion, so a failure names
itself. Unknown keys are an error, not a silent skip — a typo that grades
nothing would report a higher score for having checked less.

### Difficulty

Every scenario declares `difficulty`, 1-10. It grades what the turn **demands**,
not what it currently scores — grading by pass rate would be circular, since
every fix would relabel the scenario.

| | | |
|---|---|---|
| 1 | reflex | One step, one plausible answer. Failing it means something is broken. |
| 2 | routine | A single judgement among near neighbours — which tool, whether to speak. |
| 3 | composed | Two constraints at once, or a fact surviving a step to be used in the next. |
| 4 | conflicting | The signals disagree and one has to win, or the answer is partly a refusal. |
| 5 | frontier | Multi-hop over a long history, or a real dependency between agents. |
| 6 | compound | Several independent demands in one turn, each enough to fail it alone. |
| 7 | misleading | The most authoritative thing present is wrong, and being right means going against it. |
| 8 | two-fold | Two demands, either enough to fail it. A machine has to be understood before it can be driven. |
| 9 | three-fold | Three. Two agents share one machine and must not each do all of it. |
| 10 | four-fold | Four, and one of them is other people — directing specialists through a machine you cannot touch. |

Levels 8-10 count independent ways to fail one piece of work rather than naming
a kind of hardness. The wall is between 7 and 8.

```bash
pnpm --filter @tailored-ai/evals run eval -- --home ~/.tailored-ai --difficulty 8+
```

The report gains a rollup by level next to the one by category. Category says
which subsystem is weak; difficulty says whether the hard half of *everything*
is failing, which is a different finding.

The level is an annotation: it is excluded from the scenario digest and the
per-scenario fingerprints, so re-grading never invalidates a published run.

### Assertions

| | |
|---|---|
| `calls_tool` / `calls_tool_any` / `does_not_call` | which tools were called |
| `tool_args: {tool, where}` | one call to `tool` matched every key in `where`. Values are case-insensitive strings, or `/regex/`. |
| `posts_in` / `does_not_post_in` | which rooms the agent posted in |
| `posts_by: {agent, min, max}` | how often a named agent spoke. `min` is 1 unless `max` is given, so `{agent, max: 0}` means "stayed out" |
| `posts_by: {agent, matches}` | regex over that agent's *own* posts. `reply_matches` cannot ask this — `reply` is every post joined, so it passes when either agent said it |
| `replies: true\|false` | did it say anything outward at all |
| `reply_matches` / `reply_not_matches` | regex over the reply |
| `reply_mentions_any` / `reply_mentions_none` | case-insensitive substrings |
| `reply_mentions_all` | every one must appear. "Relay all of it", which a character floor only approximates |
| `min_reply_chars` / `max_reply_chars` | length |
| `max_overlap: {threshold, prior_reply\|text}` | word-trigram overlap. A fresh reply scores ~0.1–0.2 against the agent's own last message; a re-emitted one ~0.9. |
| `prompt_contains` / `prompt_not_contains` | substring of the assembled request |
| `prompt_occurrences: {text, min, max}` | how many copies of a block reach the model |
| `prompt_max_tokens` | bloat tripwire |
| `max_rounds` / `max_tool_calls` | effort tripwires — a turn that gets more expensive without getting wrong |
| `calls_by: {agent, tool, where, min, max}` | how often a named agent *ran* a tool. Reads executions, not requests |
| `does_not_call_with: {tool, where}` | no call to `tool` matched `where`. Either side takes a list. `does_not_call: [exec]` forbids `aws s3 ls` as firmly as the delete |
| `world_state: {…} \| goal` | the machinery **ended** in this state — the win condition |
| `world_reached: {…}` | the machinery **passed through** this state. What every step but the last one needs: fabricate-then-install ends at `installed`, so `world_state: {part: made}` scores a completed step as skipped |
| `answers_correctly: true \| {within}` | the agent submitted the right answer to its `oracle:`, within N attempts |
| `fact_reaches: {fact, stage}` | a declared fact got as far as `discovered` / `shared` / `received` / `used` |
| `score_at_least: 0.5` | fraction of the scenario's `milestones:` points earned |
| `judge: {rubric}` | LLM-graded, `--judge` only |

### Bigger scenarios

Four fields exist for scenarios that run a team rather than an agent. Full
rationale in [docs/evals.md](../../docs/evals.md#grading-a-system-rather-than-an-agent).

```yaml
tools:                          # instruments that exist only here; the world answers them
  - name: rotate_ring
    description: Turn the observatory rings and try to lock them.
    params: { key: The harmonic key., sequence: The ring sequence. }

wake:                           # a roster and a ceiling, not a list of turns
  room: expedition
  rounds: 8
  agents: [atlas, boron, cipher]

milestones:                     # partial credit; `when` is any assertion
  - { id: alignment_locked, points: 10, when: { world_state: { alignment: locked } } }

facts:                          # what has to travel, and between whom
  align_key: { value: "{{token:alignkey}}", discoverableBy: [cipher], requiredBy: [atlas] }

rooms:                          # `members:` makes the communication graph partial
  - { name: north, members: [atlas, cipher], incoming: [...] }
  - { name: south, members: [cipher, boron], incoming: [...] }
```

A room with no `members` holds everyone who takes a turn, which is the old
behaviour. Naming them is what forces a **relay**: with one shared room, "get
this fact to the agent who needs it" collapses into "say it out loud". Note that
a poll only delivers what is unread, so a room whose occupants have nothing new
never wakes anybody — give each room something `incoming` or its agents are
silent for reasons that have nothing to do with the model.

An agent's `tools:` allowlist governs who holds which instrument, so declaring a
tool is not the same as handing it out. A `rounds:` wake stops early after a pass
in which nobody spoke and nothing in the machinery moved. A failing row prints
its milestone ladder and its fact routing under the failure lines.

## Comparing two runs

```bash
pnpm --filter @tailored-ai/evals run eval -- --home ~/.tailored-ai --out results/before.json
# ... change something ...
pnpm --filter @tailored-ai/evals run eval -- --home ~/.tailored-ai --out results/after.json
pnpm --filter @tailored-ai/evals run eval:compare -- results/before.json results/after.json
```

`compare` refuses to pretend two runs that covered different scenarios are
comparable — it reads the scenario list each report carries and names how many
one side never ran — warns when the model or repeat count differs, and calls a
one-run move **noise** rather than a regression, since at three repeats one
flipped run is 33 points and treating that as a finding means chasing sampling
forever. Exit code is 1 if anything regressed beyond the noise floor, so it
works in a script.

## Options

```
--home <dir>          take baseUrl / model / temperature / maxTokens /
                      providerExtra / thinking from a deployment's config.yaml
--base-url <url>      OpenAI-compatible endpoint (default 127.0.0.1:8000/v1)
--model <id>          required unless --home supplies one
--repeats <n>         runs per scenario (default 3)
--concurrency <n>     scenarios in flight (default 4)
--filter <s>          scenarios whose id contains <s>, or whose category is <s>
--difficulty <spec>   levels to run: 4, 4+, 2-3, 3,5. Composes with --filter
--seed <n>            base seed, `off` to disable (default 1000)
--min-score <0..1>    exit non-zero below this
--dry-run             validate scenarios and print the plan, call no model
--verbose             stream worker stderr
```

`--home` is how you benchmark a *deployment* rather than a hypothetical: it
picks up that instance's sampling controls, including the `providerExtra`
carrying vLLM's `repetition_penalty`. Run without it and the repetition
scenarios are the first to fail.

### Exit codes

`0` only when every scenario ran and, if `--min-score` was given, the score
cleared it. `1` otherwise — including when a scenario *failed to run at all*.

That last case needs its own exit code because the score cannot express it. A
scenario whose worker died has no runs, so it contributes 0 passed of 0 total:
it does not lower the percentage, it quietly leaves the denominator. A run that
lost a third of the set to a crashed worker would otherwise print a healthy
number and exit clean. The report is still written either way — the summary
names each scenario that did not run, and the score above it covers only the
ones that did.

## Report files

`results/<timestamp>-<model>.json`, holding the score, every check, and the
provenance a number is worthless without: git SHA, whether the tree was dirty,
model, endpoint, repeat count, seed, and a digest of the scenario set — taken
over what each scenario sends and grades, so annotating one does not invalidate
every run before it. Full request bodies are kept for failing runs only — that
is where they are the diagnosis rather than dead weight.

`meta.scenarioFingerprints` is that same digest **per scenario**, for the ones
this run covered. The set hash can say a definition somewhere moved; only the
per-scenario version can say which, and that is the difference between a
published number a reader can trust and one quietly describing a question that
has since changed. A committed baseline is checked against the current files on
every test run — see
[docs/evals.md](../../docs/evals.md#a-published-result-must-still-describe-its-scenario).

`meta.usage` totals the tokens, split into `input` and `output` (and `cacheRead`
where the provider reports one). `meta.cost` is the dollars plus the rates it
was billed at. Input and output are never collapsed into one figure: they are
priced an order of magnitude apart, and one number cannot tell a bigger prompt
from a chattier model.

A model with no known price gets tokens and no dollars, never a guess. Money is
priced once at write time and read everywhere else, so an old run keeps the
rates it was actually billed at. Tokens do backfill from the runs, which is why
reports written before `meta.usage` existed still show their size.
