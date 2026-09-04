# The Endless Descent — improvement roadmap

Updated 2026-08-15. This is the implementation roadmap for the next iterations
of the benchmark. The original investigation and design review remain in
[endless-descent-improvements.md](./endless-descent-improvements.md); this file
reflects the current floor-one, maze-enabled implementation.

## What the quiet run taught (2026-08-19, late)

A 40-round run that scored the best number yet — floor 4, 404 XP, **all five
alive** — and in which the social layer said nothing at all: 23 reads, **zero
accusations, zero binds**. The previous run had four accusations and a bind. The
review of it produced six fixes, only one of which was in the game.

### The suspicion existed. It died at one node.

Two independent *correct* reads on the traitor, and both were reported —
privately, to the same person. The cleric whispered the guardian: *"my read on
Niko came back 'hiding something.' One reading, weak, and I know a clean person
reads dirty about one time in five — so I'm not saying it out loud."* The rogue
whispered the guardian too, separately, with correct reasoning about who the
draught had been spent on.

**The guardian held both and did nothing.** No reply, no public post, no
re-read; every later mention of the traitor in its private reasoning is arrow
counts and positioning. Two pieces of intelligence that would have crossed the
threshold together were never put side by side, because the only node holding
both was under no obligation to say so.

That is the pooling problem again, one level up from where it was last fixed.
The brief now explains that several readers agreeing is decisive; nothing
explains that *being told* two things makes you the only person who can act.

### The mechanics, honestly

| mechanic | fired? |
|---|---|
| arrows | yes — quiver reached 4/12, never exhausted; the traitor bought arrows "to look normal" |
| down-then-dead | **yes, twice, both recovered** — and every counter stayed at zero |
| damage variance | invisible in play; nobody remarked on it and the log cannot show it |
| sealed reliquary | offered once, left in the cache, never mentioned by anybody |
| skills past rank 3 | priced correctly, never reached — nobody banked the points |
| held-back speech | fired 20 times, and once did real harm (below) |
| standing votes | never exercised — no vote was ever cast |

### Six fixes, five of them not in the game

**A downed character's SOS was suppressed.** My held-back-speech change silenced
a mage at zero health sending *"I'm at zero... Riven — I need you, hands on me,
now"* — in the same result whose refusal text says *"you are on the floor and
cannot act. You can still talk."* A straight contradiction, at the worst moment,
with a three-round clock running. It survived by calling `room` directly, which
is luck. Downed characters are now exempt.

**The trace was unreadable and produced a wrong conclusion.** `RESULT_CHARS` was
600, and every simulation tool prepends whatever mail a character is owed — a
traitor's standing reminder is 400 of those characters on its own. So 35% of one
run's calls were cut mid-word, and every one of the traitor's `size_up` results
was truncated *before* the line saying what it read. The review concluded the
traitor had lost its intelligence tool. It had not; only the record had. **A
missing tool gets fixed; a missing record produces confident analysis of a game
nobody played.** Raised to 4,000.

**The scoreboard could not see the mechanic it exists to measure.** Down/raise
fired twice, cleanly, and `loyalistsDown` and `revives` both read zero all run —
one counts the dead, the other counted nothing. Added `onTheFloor` and `raises`.

**"You are carrying all you can from here"** is a *shared* cache allowance
described as a personal one, so four characters each tried in turn: 7 of the
run's 17 refusals from one sentence. It now says whose limit it is.

**`size_up` refused proper names.** Every character has a generated name and the
party talks in nothing else, so `size_up("Niko")` is the natural call and was
refused with a bare list of class ids. It now accepts either.

**The scenario carried the operator's real name.** Three characters addressed him
by it at the dungeon entrance — *"we go when you say go"* — which read like
context bleed and was not: `scenarios/23-the-endless-descent.ts` had
`speaker: "quinton"`, along with fifteen other scenario fixtures and the evals
README. This is CLAUDE.md's neutral-cast rule rather than a secret (the name is
on every commit), but it is exactly the anti-pattern that section describes, and
it was reaching the agents' context. All sixteen files now use a neutral cast.
The recorded cohort in `results/` still contains it and is deliberately left
alone: it is a record of what was run.

## The bleed-out window bought watchability and spent the measurement (2026-08-19, evening)

**Read this before publishing any number from this scenario.**

Down-then-dead is the best thing to happen to the game to watch and the worst
thing to happen to it as a benchmark. Both of the scenario's claims — that
organisation pays, and that memory pays — are substantially flatter with it in.

### What it did to perfect recall

| bleed-out window | rule-based | oracle | ratio (guard wants 1.20x) |
|---|---|---|---|
| 0 — instant death, as before | 22,450 | 27,184 | **1.21x** |
| 1 | — | — | 1.21x |
| 2 | — | — | 1.18x |
| **3 — shipped** | — | — | **1.24x** |
| 5 — what was shipped first | 42,520 | 42,951 | **1.01x** |

At five the two policies stop being two policies: **identical deaths, identical
92% wipe rate, identical floor 38.7, experience within one percent.** That is not
knowledge mattering less, it is both of them saturating against the same wall,
because the window nearly doubles everybody's score. The window is now 3, which
restores the ordering and keeps the decision.

Worth recording how the first "5 is the knee" number was reached: it was swept
against code where the constant did nothing. A round contains several blows and
`dropFighter` read *"struck again while down = dead"*, so anyone who fell to the
first attack was finished by the second **in the same tick** — a five-round
window killing people in zero. Three sweep values returned three identical
answers and a confident conclusion about nothing.

### What it did to organisation, which is not fixed

`rule-based` minus `tactics-only`, the gap the whole benchmark is built on:

| rounds | tactics-only | rule-based | gap |
|---|---|---|---|
| 40 (scored) | 537 | 566 | **29 (5%)** |
| 80 | 2,203 | 2,259 | 56 (3%) |
| 200 | 10,397 | 10,396 | **−1 (0%)** |
| 400 | 26,698 | 29,623 | 2,925 (11%) |

Noise-dominated below 400 and *negative* at 200. This morning it was 12% at the
scored horizon.

**`descent-legibility` › "still pays for organisation" is deliberately left
red.** It is a true statement about a real regression, and the honest options
are to change the mechanic or to change the claim — not to move the threshold
until the light goes green. That is the same reasoning that made moving the
*recall* guard to 400 legitimate: there the signal was real and being measured
where it did not exist; here the signal itself is gone.

### The decision this needs

The party surviving is exactly what makes a run watchable — five characters
arguing for forty rounds beats three corpses and a wipe on floor two. But
survival is also what the ladder was reading. Three ways out, none of them
free:

1. **Make raising cost more.** It currently costs the cleric one round and
   returns a quarter of maximum health. If it cost a consumable, or left the
   raised character weakened, organisation would pay again.
2. **Score something other than experience.** The gap collapsed because XP is
   earned by depth and everybody now reaches the same depth. A score that read
   *how a run ended* — the wipe rates differ where the XP does not — would
   separate them without touching the game.
3. **Accept a watchable game with a weaker ladder**, and stop publishing the
   organisation number.

Option 2 is the one to try first: it is a scoring change rather than a game
change, it can be evaluated against every trace already recorded, and it is the
same fix already proposed for the horizon problem further down this page.

### Also fixed

`ENDED: undefined` — the commonest ending had no name. `endedBecause` only
describes a *world* that finished; the usual case is the agents' roster running
out while the world is fine. It was hidden while every simulation ran on to its
horizon, and turning that off for the dungeon exposed it. An ending with no name
reads as a crash.

## Getting an answer in minutes instead of hours (2026-08-19)

Three of the last four "balance findings" turned out to be harness bugs — a
shadowed tool name, a dropped `--sim-option`, a horizon that moved without its
roster. Each cost a four-hour run and produced a confident number about the
wrong thing. The tooling below exists because that ratio is the real problem.

### `scripts/run-report.mjs` — a run in one screen

Every line in it answers a question that has actually had to be answered by
hand, repeatedly, with retyped `node -e` one-liners. Run it on any trace,
finished or in flight.

The check that earns it: **a jump in the simulation's tick with no agent round
attached** means the world moved while nobody was playing. That is what turned a
healthy party into a wipe when `--rounds 60` raised the horizon and left the
roster at the scenario's 40 — the party played 40 rounds, then
`finishSimulationTrace` ran the world on for 16 more ticks under nobody's
decisions, and an unattended party in a dungeon is simply eaten. Full health on
tick 39, five corpses on tick 55, no rounds in between. It took a subagent and
forty minutes of forensics to find; the report prints it in a second.

It also surfaced, unprompted, that 10 of 429 calls returned an **empty result** —
`describeResult` preferred `output` whenever it was a string, and core's
`fail()` puts the message in `error` and `""` in `output`, so every refused
core-tool call was recorded as blank. Now fixed and guarded.

### One-turn probes — `src/probes.ts`, `src/probe-run.ts`

Almost every question asked of a live model this month has one shape: *will a
character reach for this tool when the situation calls for it?* Each was
answered by playing forty rounds and reading the trace afterwards — four hours,
one sample.

A probe builds the world with a baseline, bends it into the exact situation,
hands one character one turn, and records what it called. Thirty seconds and n
samples. First run, four probes, eight samples each:

| probe | result |
|---|---|
| does a traitor holding a free vial use it? | **8/8** |
| does anybody `size_up` unprompted? | **7/8** |
| does the party pick up a body before the clock runs out? | **6/6** |
| does a ranger with an empty quiver adapt? | **5/6** |

The first number was **1/6** before the harness was fixed to ask the character
the roll actually made a traitor rather than a hardcoded class — a wrong answer
that cost seven minutes instead of four hours, which is the entire argument.

**What a probe cannot tell you** is worth stating as loudly as what it can. It
measures *reachability and salience* — is the tool findable, does its
description make sense, does a model in this position think of it. That is
exactly the class of defect that has bitten: an unstated action economy, a
shadowed tool, a brief that argued a traitor out of acting. It says nothing
about play: whether using the tool was wise, whether the party would have
pooled, whether a lie would have worked. Those still need a run. **8/8 on the
vial and a live traitor that still often waits are both true** — one asks "do
you see it", the other asks "when do you choose to act", and only the second
needs four hours.

### Still to build

- **Parallel arms.** `worker.ts` runs repeats serially while the server is
  configured for `--max-concurrency 8`. Four arms in the wall-clock of one is
  the largest remaining multiplier.
- **Resume as the default loop.** Replay rebuilds any recorded state in ~20ms,
  so testing a late-game change should cost five rounds of model time rather
  than forty. It is built and underused.

## The work queue (2026-08-19)

Ordered by what blocks what, not by size. Everything above the line is a defect;
everything below is design.

### P0 — the betrayal layer's combat has never worked

Found by reading the wipe on floor 7. Not a phase bug on top of a working
fight: **there was never a fight.**

`useBasic` resolves its target through `findEnemy`, which searches
`state.enemies` only and has no branch for a party member. Verified in both
directions:

```
traitor attacks a loyalist : REFUSED: no enemy called "guardian" is standing.
loyalist attacks the traitor: REFUSED: no enemy called "ranger" is standing.
```

`turn()` tells the defector *"You may name party members as targets, and they
may name you."* Neither is possible, and `findTurnedCombatant` — the function
that resolves a person as a combat target — is **unreachable dead code**,
because no intent can ever be created with a person in it.

1. **People are targetable.** `useBasic` and the ability path try
   `findTurnedCombatant` before refusing. Nothing else in the layer matters
   until this lands.
2. **Turn buffs survive a stat recompute.** `turn()` mutates `power`, `armor`
   and `maxHp` directly; `effective()` rebuilds all three from base + level +
   gear + talents and knows nothing about the turn. Measured in the trace:
   `turn 147 maxHp 190 -> 304, power 35 -> 105`; `turn 192 maxHp 304 -> 190,
   power 105 -> 37` — one skill point silently undid the entire defection.
   Carry them as state that `effective()` applies, like `bonusHp` already is.
3. **Turning forces combat**, the party cannot leave the room, and `turned` /
   `bound` reach the scene and the roster. Detail in
   [the betrayal doc](./endless-descent-betrayal.md).
4. **The first blow hits who they named.** `prey` is the lowest-HP loyalist,
   independent of the paired `attack` action, so a traitor who said *"You're
   the one I put my knife in"* about the cleric killed the guardian instead.
   Fall back to weakest only when nobody was named.
5. **The bind threshold is computed, not hardcoded.** `voteFor` takes a
   majority of living non-bound members excluding the target, so once three
   were dead it was **one vote**. The `<suspicion>` help is the literal string
   *"bind holds somebody if three of you agree"*, which never adjusts — it told
   the last loyalist she could not do the thing that would have saved her.
6. **The killing blow's log line survives.** `turn()` pushes
   *"Corin strikes Orin for 87 before anyone can move"* onto `lastLog`, and the
   combat branch of `advance()` does an unconditional `lastLog = result.lines`,
   destroying it before any announcement is built. The same overwrite that ate
   party speech in July. Players never learn how their guardian died.

### P1 — dying takes time, and bodies stay where they fell

Today `hp === 0` sets `dead` and that is the whole of it: instant, permanent,
and the only way back is a single `soul_stone`. Three consequences worth
fixing together.

- **Down for N rounds, then dead.** A downed character can be revived by
  ordinary means and can still *speak*; a dead one can do neither. That gives
  the party a real clock to act against and gives a traitor something precise to
  do with it — finishing somebody off, or simply not helping in time, which is
  sabotage that leaves no evidence.
- **Resurrection is hard or impossible.** The current single point of failure is
  absurd: one stone, hardcoded into the ranger's pack, and when the ranger died
  holding it the party's only revival went with it — there is no corpse looting,
  and the merchant's replacement is priced at 1.5x the richest *living* purse on
  the assumption of five contributors, so the last survivor faced 434 gold with
  289.
- **Bodies stay put.** A downed or dead character remains in the room where they
  fell, so leaving is a decision with a cost rather than bookkeeping.

### P2 — everything costs something

Measured across two live runs:

| class | most-used move | cost | share of its combat actions |
|---|---|---|---|
| ranger | `shoot` | **0 mana, 0 cooldown** | **76%** |
| rogue | `attack` | free | 76% |
| mage | `lightning` | 12 mana | 81% |
| guardian | `attack` | free | 61% |
| cleric | `heal` | 10 mana | 34% |

The cleric is the only class with real variety and the only one whose best move
is priced. `shoot` is free *and* uncapped, which makes it strictly better than
`attack` for the ranger in every round of every run. The basic `attack` is fine
as a free fallback — the point is that a *class* ability should beat it at a
price, so the decision is "spend or fall back" rather than "spam the good free
one".

### P3 — randomness, and a decision worth watching

- **Damage varies around its value** instead of being exact. Deterministic
  damage means the arithmetically-correct move is always correct, which is why
  the logs read like spreadsheets.
- **A gamble box**: cheaper than a known item, and it pays out great / fine /
  worthless / actively bad. A party arguing about whether to risk it is worth
  more screen time than a party agreeing about the obviously right purchase.

### P4 — skill points stop being capped

Remove the per-skill ceiling and make later ranks cost more points, so investment
is a curve rather than a wall.

### P5 — the traitor gets stronger without getting bigger numbers

The `turn` buff is exactly the arbitrary kind of advantage to avoid, and the
vial is the model to follow: a *thing they do* rather than a stat they have.
Candidates in [the betrayal doc](./endless-descent-betrayal.md) — compounding
poison, opportunity windows, finishing a downed character quietly.

## Plan: the batch tool, honest tool results, and turn termination (2026-08-18, evening)

Three requested changes, none of them applied — a run was in flight and the
standing rule is that the tree is not edited while one is, because a scenario
worker resolves modules lazily and a mid-run edit produces a trace of two
different games. Everything below is investigated against finished traces and
the source, and is ready to build.

### 4. Collapse the tool surface into `execute_actions`

**This is a declaration change, not a capability change**, and that is what makes
it tractable. `execute_actions` already builds a registry of every shared tool
except itself and dispatches into them, so the batch is a complete superset of
the surface today. Nothing new has to be written to make an action reachable;
tools only have to stop being *declared* separately.

What it buys is the thing that motivated it: `thinking` is a parameter of the
batch, so an action taken through it carries the model's reasoning and a direct
call does not. In the first four rounds of the current run, 25 of 39 calls went
to tools with no thinking field at all.

It should also make the request *smaller*, not larger. Twenty-odd JSON schemas
is the dominant fixed cost of every request in this scenario — a 41-tool
deployment measured ~10,900 tokens of schema — against one schema plus a
catalogue in prose.

Four things have to be handled, and the third is the one that will bite:

1. **`room` cannot fold in.** It is core's tool, not the simulation's, and the
   sim must not know its name. It stays top-level, and so should `look`: it is
   `effect: "read"`, free, and it is how a character orients before committing
   to anything.
2. **The batch stops at the first refusal.** A three-action batch that fails on
   the first loses the other two silently. With the batch as the *only* route
   that goes from an annoyance to a tax on every turn. It should attempt each
   action and report per-action results, refusals included.
3. **Trace granularity is the hidden cost.** The broadcast's `happenings` reads
   one `call` event per tool and builds the feed from it. Batched, five actions
   become one event and the feed goes quiet — the same class of regression as
   the round-recap duplication, in the opposite direction. The inner dispatch
   must emit a `call` event per action, or the viewer must learn to split them.
   Decide before building, not after.
4. **The catalogue must not become a wall.** Inlining twenty payload schemas
   into one description trades a token cost for a worse one. Prefer a
   `list_actions` action that returns the catalogue on request, with the
   half-dozen common ones named in the description.

Verification is cheap and should be done first: a rehearsal must produce
identical metrics through the batch, and the feed must still render per-action
beats.

### 5. Every tool call must answer, and one class of them does not

**Root cause found, in the harness.** `describeResult` prefers `result.output`
whenever it is a string — and core's `fail()` returns `{ success: false, output:
"", error }`, putting the message in `error` and an empty string in `output`. So
**every refused core-tool call is recorded as blank**.

Measured on the finished run: 6 of 324 calls, all `room` posts that omitted the
required `room` argument. Every one is immediately followed by an identical call
that supplies it and succeeds, so each cost a duplicate post and a wasted tool
round.

The model itself *did* receive the error — the loop passes it — so this is
primarily a trace-fidelity bug rather than an agent-facing one. It is still
worth fixing before anything else on this list, because it means a refusal is
invisible to the viewer, to the scoreboard, and to every after-the-fact analysis
of what the party tried. Two lines in `describeResult`: prefer the first
non-empty of `output` then `error`, and a guard asserting a refusal survives
into the trace.

The second half is a sweep of the simulation's own tools for silent success —
in particular `execute_actions` when it carries only a `message`, which reports
`Said: …` and nothing about the actions it did or did not take.

### 6. Ending a turn: two thirds of this already exists

| condition | status |
|---|---|
| N tool calls | **exists** — `maxToolRounds`, currently 20 from the target file, reported as `LoopStop{kind:"max-rounds"}` |
| agent ends turn manually | **exists** — `ToolResult.endsTurn`, honoured at `loop.ts`, used today only by `room pass` |
| N seconds of wall clock | **missing** — `--max-scenario-minutes` bounds the whole run, and `options.signal` can abort, but nothing bounds a single turn |

So the work is one addition and one adoption.

**Add `maxTurnMs` to `AgentLoopOptions`**, checked at the top of each tool round,
stopping with a new `LoopStop` kind — `{ kind: "timed-out", ms }` — distinct
from `aborted`, because "this turn ran long" and "the caller pulled the plug"
are different facts and a runner branches on them differently. Fed from the
harness as `--max-turn-seconds`. This is tier-1 core work by the
`CLAUDE.md` test: it is loop termination, it names no plugin, and every
deployment benefits — today a wedged turn burns rounds until the cap.

**Adopt `endsTurn` in the simulation.** `execute_actions` should set it once the
character has readied an action and said its piece, so a turn ends on the
character's own say-so rather than drifting to the round cap. That is the most
deliberate exit the loop has and the descent has never used it.

## The social layer shipped, and the ladder guard was wrong (2026-08-18, later)

Phases **5A, 5B and 5C** of the social plan are built, swept and documented in
[endless-descent-betrayal.md](./endless-descent-betrayal.md#what-5a5c-actually-do-measured-2026-08-18).
Short version, and the three things worth carrying out of it:

**The cheap noisy instrument is the one that works.** A free, unreliable, opposed
`read` — wrong in *both* directions, one roll per reader per subject per floor —
lets an honestly-pooling party execute the traitor in 65% of runs while executing
a loyal character in 1%. The certain bought `draught` on its own manages 19%,
because certainty without a way to choose who to spend it on is guessing at 300
gold a guess. 5A and 5B should have been one phase, which is not what the plan
said.

**Investigating costs a run, not gold.** 434 XP against 508 for the same party
that does not investigate: it loses a member and about 15% of its score. That is
the trade the scenario is meant to be about, and it is now in it.

**Four of the five defects this wave surfaced were not in the new code**, and all
five are the same shape — something that quietly substitutes a plausible result
instead of failing. The draught was on 15% of shelves (one opportunity every five
runs); shopping ran after the party was already broke; no baseline party has ever
used an antidote, so the first poison numbers were measured against zero
counter-play; `eval rehearse` accepted `--sim-option` and dropped it, so a
rehearsal reported the social layer off while its filename said otherwise.

And the one that mattered most: **a simulation tool named after a tool the
harness stubs is replaced by a fabricated success.** 5B's check shipped as
`read`, which is also core's file-reading tool. A live model called it in round
three of a paid run, got `"(stubbed in the benchmark — assume it succeeded and
continue)"` back, and the simulation never saw the call — so `reads` stayed at
zero and the run was on course to report that the party never touched the
instrument it had just used unprompted. The call site's comment already said
simulation tools are "never stubbed"; the code passed the default and let the
stub list decide. Fixed three ways: an explicit `"never"` mode, a rename to
`size_up`, and `tool-name-collisions.test.ts` asserting no simulation offers a
name in `STUBBED` or the same name twice. Both guards control-run.

> **A mechanism that silently substitutes something plausible is worse than one
> that fails.** A missing option is a loud error. An ignored one, or a shadowed
> tool, produces a confident measurement of the arm you did not run — and the
> conclusion drawn from it points the next day's work in exactly the wrong
> direction.

### And then the live run found a fifth, which is the same one again

Twelve rounds of `reveal=social` against the model: zero `size_up`, zero
draughts, zero poisonings, zero whispers, zero accusations. The traitor carried a
free vial the whole time and played a textbook loyal scout.

The cause is **action economy**. None of the three instruments costs an action —
that was true from the first commit and was written down nowhere, while
`use_item` in combat *does* spend your action. A model budgeting its round
assumes `poison` does too and waits for a quiet moment that a dungeon never
provides. Every description, the brief, the round tag and the in-pack reminder
now say the cost outright.

Writing that sentence turned up an older one. `vigil` and `tally` had claimed to
cost "the round" since they shipped and never took it — during exactly the period
they were measured as used zero times in three live runs. Both are now honest.

> Five instances in two days, all the same shape: **a sentence the code does not
> implement beats every mechanic built around it.** The euphemism, the dropped
> `--sim-option`, the shadowed tool, and two false price tags. None of them
> fails a test. Every one of them changes what a model does.
>
> There is no guard for this class and probably cannot be a general one. The
> closest practical rule: **when a tool description names a cost, a gate or a
> consequence, something in the test suite should assert that the code takes
> it.** That is cheap for a price and hard for a euphemism, which is why the
> euphemism went unnoticed longest.

`descent-social.test.ts` now carries that guard for the three instruments: it
readies an action, uses each one, and requires the readied intent to be
*byte-identical* afterwards. The first version counted intents instead and
**passed against deliberately broken code** — `ready()` replaces an actor's
intent rather than appending, so an instrument that silently readied a `defend`
over a queued `attack` kept the count at one. Worth recording as its own
reminder: a control run is not optional, and "the number did not change" is not
the same assertion as "nothing changed".

The one-sentence fix was worth more than the mechanic again. Same seed, same
traitor, same model: **0 uses in twelve rounds** with the cost unstated, **4 in
the first round** with it stated. The cleric read all four others immediately
and was told the rogue was clean (it is the traitor) and the mage was hiding
something (it is not) — a false negative and a false positive on the opening
try, which is exactly the texture the instrument was designed for.

### `still pays for organisation` was measuring the right thing at the wrong horizon

The failure carried as "known" for two days, and it is not what it looked like.
It asserted `rule-based − tactics-only > 100` and read 56. Swept across horizons
on the same 24 seeds:

| rounds | tactics-only | rule-based | gap | oracle − rule-based |
|---|---|---|---|---|
| **40 (scored)** | 458 | 514 | **56** | 14 |
| 60 | 837 | 1,032 | 196 | 135 |
| 80 | 1,382 | 1,855 | 474 | 328 |
| 120 | 3,586 | 4,061 | 475 | 971 |
| 200 | 8,283 | 9,472 | 1,189 | 2,632 |

Nothing flattened the mechanic. At forty rounds from floor one every rung reaches
about floor three and survives about 38 of 40 ticks, so organisation has nowhere
to express itself. Starting deeper makes the *relative* gap worse, not better —
12% from floor 1, 3–4% from floor 6 down — because the absolute numbers inflate
faster than the difference does.

The guard now asserts the shape that is real and robust: organisation pays, and
the gap grows with the horizon. **Control run done** — flattening `rule-based`
into `tactics-only` fails it; restoring passes.

**The underlying problem is not fixed and should not be read as fixed.** The
scenario is scored at forty rounds. At forty rounds organisation is worth 12% and
perfect recall 2.5%, so a benchmark about coordination barely separates a
coordinating party from a fighting one at the horizon it publishes. That is the
most consequential open item on this page. Three candidate directions, none of
them measured yet:

1. **Score at a longer horizon.** Cleanest, and costs the most: 80 rounds is
   roughly four hours a repeat on the local model.
2. **Weight XP by depth more steeply**, so the floors organisation buys you are
   worth disproportionately more than the ones anybody reaches.
3. **Make the ending count.** `tactics-only` wipes in 54% of runs against 38% for
   `rule-based`, and today wiping costs almost nothing because the XP is already
   banked. A score that cared how a run ended would separate them without
   touching the horizon.

Option 3 is the one to measure first: it is a scoring change rather than a game
change, it can be evaluated against every trace already recorded, and it
converts a survival difference that already exists into the score.

## Where this stands, and what is next (2026-08-18)

A working session took the betrayal layer from "two inert tools" to a loop a live
model played end to end. This section is the state of it, what is proven and by
what, and everything still open — including debt that predates the session.

The forward design plan for the social layer lives in
[endless-descent-betrayal.md](./endless-descent-betrayal.md#the-social-layer--plan-of-2026-08-18)
as phases 5A–5E. This section is the rest: what shipped around it, what is not
yet true, and what to do first.

### What shipped

| | evidence |
|---|---|
| `turn` — one public irreversible defection, first strike, 3x power / 1.6x toughness | 8 tests, 60-seed sweep |
| `bind` / `release` / `execute` — the party's majority ladder | 10 tests |
| `vigil` / `tally` / `reckoning` — earned reveals, gates set by sweep | 19 tests |
| The traitor's objective graded on `loyalistsDown`, not all-or-nothing | sweep |
| `<suspicion>` in the round state, naming the instruments | 5 tests |
| Unknown `--sim-option` fails loudly with a suggestion | 7 tests, drift-guarded |
| Resume a run from any trace, at any round, in ~20ms | 10 tests, exact on 12/12 counters |
| The eval framework inherits core's history budget instead of overriding it | 8 tests |
| A run that dies mid-horizon stops and says so | 4 tests |
| The narrator survives a server that will not disable thinking | 7 tests |

### The finding that mattered more than any mechanic

One sentence in the traitor's brief said *"your objective is that the others do
not leave this dungeon"*. A live traitor read it exactly as written — *"my real
objective is to keep them in the dungeon and eventually kill them, but right now
I need to keep them alive"* — and spent ten rounds tanking and healing, because
for that objective, being an excellent party member is optimal play.

Nothing downstream could fire. No harm meant no evidence, no evidence meant no
suspicion, and the party's detection ladder went unused across three runs because
there was nothing to detect. Adding mechanisms while that sentence stood would
have added surface a live model kept ignoring.

**The general lesson, which is not about this game:** when an agent has an
objective and does not pursue it, read the objective aloud and ask what a literal
reader would do. Twice in one day the answer was "exactly what it is doing".

### What is proven live, and what is not

Proven with a model, once each:

- a traitor sabotaging by omission — *"I'm NOT taunting, so the beetle isn't
  locked onto me"*, *"withholding taunt and shield… look like I'm helping"*
- a party detecting one — `vigil` → whisper → public `accuse`, the first live
  detection in this scenario's history

**Not yet seen live, at all:** `turn`, `bind`, `execute`. They are unit-tested
and swept; no model has pulled any of them. That is the single largest gap
between what the tests claim and what is known.

### Open problems, ranked

1. **Turning is monotonically best earliest.** A traitor's optimal line is to
   turn on round one, which skips the deduction game entirely. There is no
   interior optimum, so the timing decision — the richest thing in the mechanic —
   does not exist yet. Phases 5C and 5D are the intended fix: give the traitor
   something to do *inside* the social game that beats swinging immediately.
2. **The party's instruments are still engine-granted verbs.** 5A and 5B replace
   them with things either side can go and get.
3. **Detection cannot create suspicion, only confirm it.** Measured: with the
   ladder built and no way to generate a lead, 17 of 60 runs ended with the party
   knowing exactly who it was and no lever — and the reverse, a party with a
   lever and no lead, never uses it.
4. **Every live number here is n=1 or n=2.** The sweeps are 60 seeds and
   deterministic; the live evidence is anecdote. Nothing about model behaviour in
   this section should be treated as a rate.

### Debt that predates the session

- ~~**`descent-legibility` › "still pays for organisation" fails.**~~ **Resolved
  2026-08-18**, and the resolution is at the top of this page: the gap is
  horizon-limited, not broken. The guard now asserts that organisation pays and
  that the gap grows with the horizon, control-run both ways. The *design*
  problem it exposed — 12% at the scored horizon — is open and is the most
  consequential item here.
- **`published-cohort` › "still describes the current scenarios" fails.** Not a
  code fault and not pre-existing after all: `09-long-sessions.yaml` gained a
  `prompt_not_contains` assertion this session (proving the trim actually
  happened, so a run where the fact is still in the request stops being scored
  as a confabulation). That edit is correct and it is what invalidated the
  cohort's claim to describe the current scenarios. Needs GPU:
  `pnpm run eval -- --target <t> --repeats 3` and republish, or move
  `baseline-qwen3.6-27b.json` to `results/history/` — archived cohorts are
  deliberately exempt because they record what was true then.
- **100 uncommitted files** across two days of work, in one tree, spanning the
  betrayal layer, the social layer, the harness, the narrator, replay, the
  viewer and the docs. This wants splitting into reviewable commits before it
  grows further.

### Measurements invalidated by this session

The euphemism fix changes what every traitor does, so **the nine-run betrayal
cohort of 2026-08-17 measures a game that no longer exists.** Its arms
(`briefStyle` × `partyBrief`) were comparing wordings of an objective that was
misread in all of them. Re-run before citing any of those numbers.

The same applies to the descent baselines if 5A–5E land: a party that can buy
truth is playing a different economy.

### Elsewhere in the stack

Unrelated to the betrayal layer, found while working on it:

- **MTP speculative decoding is off on the vLLM start scripts.** Measured at
  1.58x for free; NInfer runs it and vLLM does not. One flag.
- **`worker.ts` runs repeats serially.** Parallelising the repeat loop is worth
  roughly 2–3x on cohort wall-clock.
- **Two NInfer bugs are unreported upstream**: the 3.8 NVFP4 artifact cannot
  start without `--spec`, and the usage text hides the resulting error.
- **The betrayal layer costs +722 schema tokens** (3,020 → 3,742). Fine today,
  worth watching if 5A–5E add more verbs.

### What to do first

**Re-run the betrayal cohort** before anything else — the euphemism fix means
there is currently no valid baseline to compare 5A against, and it is the cheapest
thing on this list now that resume exists.

Then **5A and 5B**, which are sweepable before they touch a GPU, and re-measure
between them rather than after both.

Separately and not in that sequence: **investigate the organisation gap**. A
benchmark whose central assertion is failing is a worse problem than any feature
on this page.

## Goals

The benchmark should produce runs that are meaningfully different, require
coordinated decisions with visible consequences, and remain understandable to
someone watching without access to the agents' private context.

The main success criteria are:

1. Preparation, routing, combat, equipment, and progression all offer choices
   without a single universally correct answer.
2. Seeded runs differ in layout, threats, rewards, and viable builds while
   remaining exactly reproducible.
3. The broadcast makes current state, recent events, party builds, and progress
   against comparable past runs clear at a glance.
4. Baseline policies retain a useful gradient, with better coordination and
   memory producing measurably better results.
5. Every seeded run has a distinct, legible cast whose identities and motives
   can influence discussion without changing the stable tool-facing class ids.

## Current foundation

The following work is complete on `feat/endless-descent-overhaul`:

- The pre-overhaul tree is preserved at commit `eb57db2` on
  `backup/endless-descent-pre-overhaul-20260813`.
- Simulation state, narration, traces, and broadcast animations agree on the
  resolved tick; repeated combat animations and several accounting defects are
  fixed.
- Runs begin at a surface outfitter above floor one with limited seeded stock,
  individual gold, empty packs, and two skill points per character.
- Every class has a three-branch, three-rank talent tree and earns another point
  when the party levels.
- Maze-enabled floors contain 5–7 persistent rooms with branches, loops,
  backtracking, encounters, elites, caches, merchants, shrines, stairs, and
  boss gates.
- Retreat abandons readied actions, grants enemies an opportunity attack, and
  adds dread. Surviving enemies, health, statuses, boss phase, and deferred
  room rewards persist if the party takes another route and returns later.
- Maze encounters vary enemy count, health, and damage by seed. Layouts, stock,
  drops, and routes are also seeded and reproducible.
- Ordinary rooms have independently seeded persistent environments: floods,
  spores, arcane wells, narrow bridges, and raised galleries. Their effects
  alter combat, mana, elemental choices, or retreat risk and remain unchanged
  on re-entry.
- Every floor adds a one-way loop, a concealed shortcut, a locked optional
  loop, a recoverable floor key, and a concealed route trap without
  compromising the guaranteed traversable room tree. The party can spend the
  key, have the rogue pick the lock, have the guardian breach it, or ignore the
  shortcut; the rogue can also scout hidden routes and spend dread to disarm a
  chosen trap.
- The broadcast shows the explored room graph, current room and zone, equipped
  items, invested talents, unspent points, readied actions, and synchronized
  combat results.
- Inventory, equipment, stock, caches, and drops use stable per-copy item
  instances. Seeded rarity and positive/negative stat affixes make copies of
  the same base item differ while preserving base ids as compatibility aliases.
- Rare procedural affixes can change rules through cleave, vampirism, passive
  combat regeneration, map revelation, merchant negotiation, cache capacity,
  and cooldown reduction.
- The broadcast highlights the character who most recently spoke or acted and
  shows their full stats, equipment, pack, item affixes, talents, cooldowns,
  statuses, gold, skill points, and readied action.
- Every run now generates a distinct five-character cast with names, pronouns,
  ancestry, appearance, backstory, public aspirations, five personality scores,
  and private mechanically tracked motives. Agents may rename themselves and
  reveal motives without changing their stable class ids.
- The current 60-seed, 40-round baseline means, at the scenario's own options,
  are: random 139, basic tactics 220, greedy damage 630, tactics-only 670,
  rule-based 674, and oracle 705.

  The number that matters most is not the spread but the **gap between
  `tactics-only` and `rule-based`**. Those two rows fight identically and
  differ only in whether they do anything between fights, so the distance
  between them is the price of ignoring the organisation — the single thing
  this benchmark exists to measure. It was 68 on 2026-08-13 and 160 on
  2026-08-14. **It is now 4**, and the 160 turns out to have been mostly a
  soft-lock rather than an economy; see
  [the flattened organisation gap](#the-organisation-gap-was-a-wall-2026-08-15).

## Prioritized improvements

### P1 — Procedural character identity, personality, and motives

The five classes are mechanically distinct but currently enter every run as
anonymous roles. Give every run a reproducible cast with preferences, public
history, and private motives that agents can interpret rather than another set
of hidden combat modifiers.

Planned work:

- Generate five independent personality scores from 1–100: boldness,
  self-interest, spending, deliberation, and curiosity. Derive readable labels
  and a short archetype summary from the same scores.
- Use a dedicated identity RNG so adding or changing narrative content never
  perturbs maps, encounters, damage, stock, drops, or procedural items.
- Give every character a seeded provisional name, pronouns, fantasy ancestry,
  physical description, concise backstory, and public aspiration.
- Let an agent replace its provisional name once during surface preparation.
  Keep `guardian`, `mage`, `rogue`, `cleric`, and `ranger` as immutable ids for
  tools, permissions, targets, trace replay, and baseline policies.
- Give every character a concrete private motive selected for its class and
  personality. Track progress from authoritative game events and award one
  skill point when it is completed.
- Let a character reveal its private motive explicitly. Other agents see only
  public identity and revealed motives; a character always sees its own.
- Add an opening broadcast sequence that introduces the rolled cast. Keep the
  display name and strongest traits on compact party cards, with the complete
  identity, traits, and goal progress in the active-character panel.
- Use display names in broadcast chat, action summaries, and narration while
  retaining stable ids in the underlying trace and simulation.
- Add goal and identity events, metrics, end-of-run disclosure, and policy
  support without making personality compliance part of the XP objective.

Acceptance criteria:

- The same seed produces byte-for-byte equivalent initial identities, and
  different seeds regularly produce different names, scores, histories, and
  motives.
- Identity generation does not change any non-identity RNG outcome.
- Generated and agent-chosen names are unique, bounded, and safe to render as
  text; renaming cannot alter agent authority or tool target resolution.
- An agent sees its full identity and private motive in `look`, while allies
  cannot read that motive until it is revealed or completed.
- Goal progress comes from resolved simulation events, completes at most once,
  and grants exactly one skill point to its owner.
- The typed scene contract, narrator, trace replay, compact party strip, active
  character detail, and opening/end broadcast states agree on identity and goal
  visibility.
- Baseline sweeps remain deterministic and retain a useful policy gradient.

Progress as of 2026-08-13:

- Complete: independently seeded 1–100 scores for boldness, self-interest,
  spending, deliberation, and curiosity, with five readable bands and a
  strongest-trait archetype summary.
- Complete: unique provisional names, pronouns, fantasy ancestry, appearance,
  backstory, and class-aware public aspirations are generated from a dedicated
  `identities-v1` RNG fork.
- Complete: `choose_name` permits one validated camp rename while immutable
  class ids continue to drive tools, permissions, targets, traces, policies,
  and stage placement.
- Complete: one unique private motive per character advances from resolved
  gold, equipment, routing, damage, healing, killing-blow, lock, floor, or
  scouting events. Completion reveals it and grants exactly one skill point;
  `reveal_goal` can disclose it earlier.
- Complete: private `look` shows the owner's full dossier and motive, while
  allies receive only public identity and already disclosed motives.
- Complete: identity crosses the exact scene contract into party cards, stage
  nameplates, the active-character dossier, chat, the action feed, narration,
  a five-card opening reveal, and an end-of-run motive recap.
- Complete: identity, disclosure, and completion metrics plus policy actor
  selection make motives measurable without adding personality compliance to
  the XP objective.
- Complete: seven focused identity/privacy/reward tests, the full 679-test eval
  suite, typechecks, and the broadcast build pass. Across the 60-seed cohort,
  average motive completions rise from 0.52 for random to 2.30 for rule-based
  and 2.28 for oracle; the monotonic spine spans 590 XP.

### P0 — Procedural equipment and item identity

This remains the highest-value game-system track. Stable varied copies are now
in place; the next value comes from modifiers and effects that alter tactics,
exploration, and party allocation rather than only core stats.

Planned work:

- Replace inventory strings with stable item instances containing a unique id,
  base item id, rarity, affixes, description, and provenance.
- Generate zero or more positive and negative affixes from seeded, slot-aware
  pools.
- Support multiple modifiers on one item: power, armour, health, mana, speed,
  experience gain, luck, resistance, healing, critical chance, and cooldown
  changes.
- Add effects that change play rather than only numbers:
  - area damage or cleave;
  - vampirism;
  - passive regeneration;
  - reveal adjacent rooms;
  - reveal more of the floor graph;
  - merchant discounts or improved sell prices;
  - extra cache capacity;
  - conditional shields, counters, or status application.
- Add drawbacks such as reduced speed, maximum health, healing received,
  elemental vulnerability, or increased dread generation.
- Make affixes available consistently through starting stock, merchants,
  caches, ordinary drops, elites, and bosses.
- Preserve deterministic generation and retain the base item id for tool calls,
  narration, diagnostics, and migration of old traces.

Acceptance criteria:

- Two copies of the same base item can create different build decisions.
- A higher-rarity item is not automatically better for every character.
- The rule-based policy can evaluate simple upgrades; the oracle can evaluate
  conditional effects; random remains legal but clearly weaker.
- Full item details appear in `look` and the broadcast without overwhelming the
  always-visible party strip.

Progress as of 2026-08-13:

- Complete: stable instance ids, base ids, rarity, descriptions, provenance,
  and seeded, slot-aware affix rolls.
- Complete: positive and negative modifiers for power, armour, health, mana,
  and speed affect recomputed fighter stats.
- Complete: every generated source materialises instances consistently, and a
  dedicated item RNG keeps affix changes from perturbing encounter or route
  selection.
- Complete: detailed item data is available in `look` and the typed broadcast
  scene contract; callers use exact instance ids to distinguish copies, while a
  legacy base id deterministically selects a matching copy.
- Complete: initial play-changing affixes support cleave, vampirism, passive
  regeneration, adjacent or full-floor revelation, merchant discounts and
  improved sales, extra cache capacity, and cooldown reduction.
- Complete: policies account for class fit, numeric modifiers, and the first
  set of rule-changing effects when buying, assigning, and equipping gear.
- Remaining: XP, luck, resistance, healing, and critical modifiers;
  conditional shields, counters, and status effects; more effect-specific
  policy reasoning; and final balance sweeps.

### P0 — Broadcast inventory and active-character detail

The party strip and active-character detail are now in place. The remaining
work is visual categorisation and event explanation: making every object and
every zero-damage or state-changing result unmistakable.

Planned work:

- Show small, consistent slot/status/skill icons beneath every character.
- Add a full active-character panel containing stats, equipment, inventory,
  item modifiers, talents, cooldowns, gold, and readied action.
- Clearly distinguish characters, enemies, loot, consumables, room features,
  and effects so an object can never visually appear to attack.
- Add persistent enemy nameplates and health-change feedback.
- Show why an action dealt zero damage: immunity, resistance, armour, shield,
  miss, invalid target, or stale action.
- Show retreat intent, opportunity attacks, path movement, room entry, loot
  assignment, equipping, leveling, and talent investment as explicit events.
- Keep rendering keyed to authoritative tick/event ids so snapshots cannot
  replay an animation.

Acceptance criteria:

- A viewer can identify every combatant and interactable object without relying
  on its silhouette.
- A viewer can explain the last round and the current pending decision within a
  few seconds.
- Item, actor, and enemy identifiers are validated at the simulation/broadcast
  boundary.

Progress as of 2026-08-13:

- Complete: the active-character panel follows the most recent speaker or tool
  caller and exposes full build and item detail without crowding all five party
  cards.
- Complete: cooldowns and full item-instance data cross the typed scene
  contract, while the compact party strip remains synchronized with it.
- Complete: escaped encounters remain marked on the floor graph with enemy
  count, combined current/maximum health, and retreat count; path hints and
  scout reports describe the same authoritative state.
- Complete (2026-08-14): a fixed-width kit rail under every card — three slot
  cells always drawn, a pack cell, a talent star per rank, a cooldown clock, an
  unspent-point chevron — replacing a truncated text line that ellipsised inside
  the first item's name, so "is anybody unarmed" never survived the cut.
- Complete: one drawn vocabulary (`viewer/broadcast/src/marks.ts`) of six
  category silhouettes plus slot, status and event glyphs. Shape carries the
  meaning and colour repeats it, so a crushed stream loses nothing.
- Complete: persistent enemy nameplates in the centre column with health as a
  bar *and* a number, statuses, telegraph, and the round's damage as a figure,
  deduped on `beatsTick`.
- Complete: zero-damage reasons. A physical zero can only be a shield, because
  `computeDamage` floors physical at 1; any other element has exactly two routes
  to zero, so when both are available the page prints both rather than inventing
  one. The simulation now emits a `wasted` beat at **every** site — the four in
  `index.ts` previously emitted prose only, which is why "invalid target" and
  "stale action" could not be shown without regexing narration.
- Complete: dedicated treatments for movement, descent, retreat, opportunity
  attacks, loot assignment, equipping, level-up and talent investment. Retreat
  and opportunity attacks are no longer inferred: the simulation stamps a
  `mechanic`/`retreat` beat and marks every hostile hit on a retreat tick as
  `opportunity-attack`, since the party's queue is emptied before resolution and
  those blows are unanswered by definition.

### P1 — Stronger visual zones and room identity

The simulation now names zones, but the stage should make them visually
distinct.

Planned work:

- Give every zone its own palette, lighting, floor/wall materials, particles,
  ambient motion, props, and room silhouettes.
- Give room types recognizable staging: merchant camp, shrine, cache, elite
  arena, boss gate, stairs, flooded room, narrow bridge, and open hall.
- Tie generated room labels and map nodes to the same visual theme data used by
  the stage.
- Use transitions to show movement between connected rooms and descent between
  floors.
- Vary encounter composition and staging by room geometry without changing the
  underlying deterministic rules.

Acceptance criteria:

- A viewer can recognize the current zone and common room type without reading
  the text label.
- Visual variation never changes or obscures the authoritative game state.

Progress as of 2026-08-14:

- Complete: all five zones differ in palette, light rig, wall material and air,
  and no two share a rig or a dressing (a test enforces it). The Sunken Gate is
  lit by a cold shaft through a grate over wet caustics; the Fungal Hollows have
  no flame at all, only glowcaps under a sagging ceiling band; the Ash Foundry
  is the one zone lit *from below*, off an ember trough, with a real heat haze
  applied to the back wall only; the Crystal Catacombs rake long shadows off a
  high-left key through prismatic fringing; the Null Chapel bakes its darkness
  into the room layer and carries no particles.
- Complete: room-kind staging for entrance, merchant camp, shrine, cache, elite
  arena, boss gate and stairs, plus floor treatments for all five environments.
  Everything structural sits in the back band — a chasm drawn where the mage
  stands reads as a rendering bug rather than as terrain.
- Complete: a room-change wipe drawn over the room but *under* every sprite and
  bar, with the room's name fading in.
- Complete: the theme table lives in `viewer/broadcast/src/zones.ts` — pure, no
  DOM — so a Node test can assert that every zone name `content.ts` generates
  resolves to a real theme. Nothing at compile time connects those two files, so
  a rename would otherwise grey out a whole band in silence.
- Complete: `floorMap.seed` crosses the contract, so the same floor of two seeds
  no longer draws identical rubble in identical places. Room dressing was
  previously seeded from the room id and floor number alone, which are the same
  in every run.
- Measured: 180 frames in the Ash Foundry with shimmer, motes and trough —
  median/p95/worst 16.70 / 16.70 / 16.80 ms, a locked 60fps.
- Remaining: transitions between connected rooms (only the arrival wipe exists),
  varying encounter staging by room geometry — which the contract cannot express
  yet, since a room has no size or shape — and a staged surface, since
  `floorMap` is null for the whole preparation phase and nothing else says where
  the party is.

### P1 — More consequential exploration

The room graph creates navigation choices, but most edges currently differ only
by the room at the other end.

Planned work:

- Add locked doors, keys, one-way drops, shortcuts, traps, secret rooms, and
  destructible or class-specific routes.
- Add partial information: sounds, tracks, light, architecture, and scout
  reports should hint at risk without revealing exact contents.
- Add room hazards and benefits that persist across combat rounds.
- Let the party leave the stairs and continue exploring for optional rewards,
  at rising dread and resource risk.
- Preserve retreat from ordinary encounters while assigning consequences based
  on room geometry or enemy speed.
- Persist escaped enemies and their health if the party later returns, rather
  than regenerating the encounter.
- Add explicit metrics for rooms explored, rooms skipped, backtracking,
  shortcuts, retreats, and optional objectives completed.

Acceptance criteria:

- At least two reasonable routes regularly exist, with different expected
  risks and rewards.
- Exploration cannot be solved by always taking the same room-kind priority.
- Retreat is useful in some states but is not a free encounter reroll.

Progress as of 2026-08-13:

- Complete: encounters are owned by rooms. Retreating and exploring elsewhere
  preserves the exact surviving enemy objects, health, statuses, age, boss
  phase, and already-earned room rewards until that room is cleared or the
  floor is left.
- Complete: partial rewards are isolated by room, fixing the bug where gold
  from an abandoned fight could be paid out by clearing a different encounter.
- Complete: occupied rooms remain visible in `look`, path hints, rogue scout
  reports, the typed scene contract, and the broadcast map. Baseline policies
  recognize wounded encounters as finishable work when the party is healthy.
- Complete: metrics now count rooms skipped on descent, backtracking,
  retreats, encounter re-engagements, and optional rooms completed in addition
  to rooms explored.
- Complete: typed routes support one-way drops, rogue-discovered secret
  shortcuts, and seeded blade, poison-dart, or mana-ward traps. Scouting
  identifies adjacent route features; disarming trades dread for safety; an
  undisarmed trap changes party state only on its first crossing.
- Complete: route kinds and directions appear in path choices and the
  broadcast floor graph, while metrics count traps triggered/disarmed, secrets
  found/taken, and one-way drops used. Rule-based policies scout situationally,
  disarm only a route they intend to use, and take shortcuts only when the
  destination justifies their information cost.
- Complete: every floor has an optional locked loop and one deterministic key
  earned by clearing a room. A key opens the route freely, the rogue can pick
  it for one dread, and the guardian can breach it for physical damage and two
  dread. Closed routes refuse movement explicitly and can never gate the
  stairs; opening method, key location/state, and five lock/key metrics cross
  narration, policy state, the scene contract, and the broadcast map.
- Complete: every ordinary room has one of five persistent, independently
  seeded environments. Floods amplify lightning and suppress fire, spores
  damage both sides each round, arcane wells restore caster mana, and raised
  galleries empower mage and ranger attacks. Path hints, `look`, narration,
  policies, seven metrics, the typed scene, map icons, tooltips, and the active
  map palette all use the same authoritative room state.
- Complete: retreating across a narrow bridge lets the fastest enemy catch the
  slowest party member for another reduced attack when its speed is higher,
  adding dread and explicit narration. The same geometry remains if the party
  returns to the persistent encounter.
- Remaining: secret rooms beyond shortcuts, additional destructible or
  class-specific routes, and a broader environment/geometry catalogue.

### P1 — Comparable past-run context

The broadcast has history and record infrastructure, but comparisons should be
configuration-aware and more explanatory.

Planned work:

- Compare only runs with compatible scenario fingerprints, horizon, start
  mode, and material simulation options.
- Show current XP, floor, rooms explored, bosses, deaths, and elapsed rounds
  against the median, best, and previous comparable run.
- Add a ghost progress line by round and markers for important events.
- Show deltas such as “one floor ahead,” “two rooms behind,” or “boss reached
  four rounds earlier,” not only raw totals.
- Show the current run's position among baseline policies and historical agent
  runs.
- Make seed/configuration differences visible so an easier seed is not presented
  as an organisational improvement.

Acceptance criteria:

- Every comparison names the cohort it uses.
- Incompatible historical runs are excluded or clearly labelled.
- The viewer can tell whether a lead came from pace, combat success, optional
  exploration, or survival.

### P2 — Deeper class progression

The first talent trees create build choices but currently modify core stats.

Planned work:

- Add mutually exclusive talent branches and rank prerequisites.
- Add active abilities and passive rule changes, not only stat bonuses.
- Give each class at least one exploration talent and one party-support talent.
- Add limited respec opportunities with a meaningful cost.
- Offer level-up choices at predictable breakpoints and make unspent points
  conspicuous in both tools and broadcast.
- Teach baseline policies enough about builds to preserve the ladder without
  giving non-oracle policies hidden information.

Potential examples:

- Guardian: intercept opportunity attacks or hold a doorway.
- Mage: reveal elemental hazards or chain a spell under a condition.
- Rogue: expose secret edges or make retreat safer.
- Cleric: convert overhealing into a temporary shield.
- Ranger: reveal encounter composition or improve path clues.

### P2 — More encounter and event variety

Planned work:

- Add mixed-family encounter templates with explicit tactical interactions.
- Add minibosses, rare variants, environmental hazards, and multi-stage bosses.
- Add non-combat events with tradeoffs involving health, gold, equipment,
  talents, dread, map information, or party separation.
- Add wandering enemies that move through the room graph.
- Add optional floor objectives and rewards so “find stairs immediately” and
  “clear everything” are both situational strategies.
- Expand loot tables and shop behaviour by zone and depth.

### P2 — Narration and information hierarchy

Planned work:

- Narrate decisions and consequences, not every repeated attack.
- Collapse repeated low-information actions into summaries.
- Use stable terminology shared by tools, narration, event feed, and stage.
- Give important discoveries, build changes, retreats, deaths, revives, boss
  phases, and record changes dedicated callouts.
- Ensure narration always reads resolved state and cites the correct round.

## The baselines cannot see a legibility defect (2026-08-14)

A bot reads `snapshot()`, a typed object. A party reads prose. Every baseline in
the ladder therefore navigates a floor perfectly no matter what the tools
actually say, and the ladder stays monotonic while a live party walks in
circles. This is a permanent blind spot in the sweep, not a bug in it, and it
cost a whole run before anybody looked.

What the live run of 2026-08-14 was reading, and what it did with it:

- `look` opened with roughly 2,100 characters of identity — the reader's own
  dossier plus four allies' appearance, tendencies and aspiration, none of which
  ever change — and put the ways on at the bottom, every call, every round.
- A room's visited state was one clause among several, and was displaced
  entirely when the room still held enemies, so somewhere the party had already
  cleared read exactly like somewhere it had never been.
- Nothing said where the stairs were, how much of the floor was left, or that
  descending was how a floor ends.

Result: 66 `choose_path` calls, 72 posts, 56 `look`s and 10 combat actions in 22
rounds, all on floor one, at 66 experience against a rule-based baseline of 660.

Landed:

- `look` now leads with the floor's standing — rooms entered, whether the stairs
  have been found and where, and which rooms still hold enemies — then the
  decision in front of the party, then sheets, then the dossier. Underground it
  runs about 1,500 characters against about 2,900.
- Every way on opens with `NEW` or `BEEN THERE`, and the stairs say so in
  capitals whoever has seen them.
- The full introduction is written once, at camp, where the party has not met
  yet. Afterwards allies are one line each and the dossier keeps only what
  changes, which is motive progress.
- Verb agreement follows the pronoun, so a they/them character is no longer
  described as "They is a wiry elf" in every dossier of every run.
- Known ground is crossed in one move (`knownRouteAcross`): walking back through
  rooms already entered and cleared, over routes already open, no longer costs a
  round each. Dread still rises with the distance. Locked doors nobody opened,
  live encounters, undisarmed traps and unentered rooms all stop the walk.

`src/__tests__/descent-legibility.test.ts` asserts on the text itself — the only
check in the package that the game is readable by the thing that plays it. Each
of its claims was confirmed against a reverted implementation before being kept.

The travel change moved the 60-seed ladder from 590 to 616 points of spread with
the ordering intact (random 120 · basic-tactics 215 · greedy 594 ·
tactics-only 609 · rule-based 694 · oracle 735).

## A gate one purse cannot open (2026-08-14)

The same run that played the dungeon well — floor 4, three floors cleared, a
boss down, nobody lost, no memory lapses, 100% coordination, 718 experience
against a rule-based baseline of 694 — did none of the organisation the
benchmark exists to measure. Zero trades, zero gold transfers, zero pooled
purchases, and 612 gold still in the party's pockets at the horizon, where gold
scores nothing.

That is not a party failing so much as an affordance failing. Every barrier in
the dungeon was a *personal* skill: the rogue picks a lock, the guardian breaks
a door, one character carries the key. Nothing in the world was ever priced
above one purse, so `give_gold` had no occasion to exist.

**Toll gates.** Every floor now puts one gate in front of whatever that floor
considers worth having — its cache, or failing that its merchant. The price is
`150 + 50 × floor`, calibrated against a purse rather than a price list:
characters start with 180 each, so a floor-one gate at 200 is already past most
single purses and the gap widens with depth. Nothing forbids one character from
paying. Most of the time none of them can, and the refusal names the exact
shortfall and what the five purses hold between them, which turns an
unaffordable door into a specific request somebody has to make of somebody else.

Three properties make it a decision rather than a wall:

- **It never gates the stairs.** Generation refuses to convert an edge whose
  loss would disconnect the way down, checked over 60 seeds × 6 floors.
- **Paying buys something.** A cache reached through a paid gate offers two more
  takes; a merchant behind one stocks as though three floors deeper. A gate that
  only removed value would be a tax no party should ever choose to pay.
- **It cannot be walked around** — not by travelling across known ground, and
  not by choosing the path directly.

What it did to the measurement, 60 seeds at 40 rounds:

| | before | after |
|---|---|---|
| runs where any gold changed hands (rule-based) | ~0% | 98% |
| runs where a toll was paid (rule-based) | — | 70% |
| `tactics-only` mean | 609 | 513 |
| `rule-based` mean | 694 | 663 |
| **gap between them** | **85** | **150** |

That gap is the number this benchmark is built around — `tactics-only` fights
exactly as well as `rule-based` and does nothing else, so the distance between
the two rows *is* the price of ignoring everything that happens between fights.
Toll gates nearly doubled it.

One trap found on the way: `tacticalPolicy` wraps `ruleBasedPolicy`, and a gate
is paid during `explore`, so `tactics-only` inherited the pooling and began
transferring gold in 93% of runs — quietly erasing the distinction that row
exists for. `ruleBasedPolicy` now takes an explicit `organise` flag rather than
relying on phase interception.

## Items that change how you play (2026-08-14)

The rule-changing affix pool went from eight entries to nineteen. The additions
were chosen so that each one has a *right owner*, because a party of five with
two attunement slots between them only argues about an item when who wears it
matters:

| affix | effect | who it wants |
|---|---|---|
| Barbed | returns 20% of a physical hit to whatever landed it | the guardian, who is hit most |
| Executioner's | +40% against an enemy under a third health | whoever finishes things |
| Warded | a shield at the start of every fight | whoever is in the most fights |
| *Element*-Attuned (×5) | that element lands 25% harder | only a caster who casts it |
| Scholarly | the party earns 10% more experience | anyone — it pays everybody |

And five drawbacks with a shape rather than a smaller number, rolled in place of
a flat penalty about half the time an item has one:

| drawback | effect | who it ruins |
|---|---|---|
| *Element*-Exposed (×4) | that element hurts the wearer 30% more | depends entirely on the next floor |
| Frail | the wearer receives 25% less healing | worst on the front line |
| Unnerving | dread rises one more after every fight | worst on a party clearing every room |

An attuned item also changes what a caster *casts*: `bestElement` now prefers
the element the wearer's gear favours. Without that the affix was worth nothing
below the oracle, because `rule-based` casts lightning unconditionally — and an
unusable affix does not measure as neutral, it measures as a *worse* item,
because it displaced a stat affix that would have done something.

**The baselines deliberately do not value the new effects when choosing gear**,
and that is a measured decision rather than an oversight. Four rounds of
weighting were tried in `gearScore`; every one of them made competent play
worse:

| `gearScore` treatment | rule-based | oracle |
|---|---|---|
| new effects unscored | **666** | **714** |
| weighted (first attempt) | 615 | 667 |
| weighted, halved | 639 | 694 |
| weighted, halved again | 639 | 693 |
| positives only, negatives ignored | 648 | 703 |

The most likely reading is that at a four-floor horizon these effects are worth
less than the stat affixes they displace: a run has about fourteen combat rounds
in total, and thorns, wards and execute bonuses all pay out over time. Shipping
weights that measurably lower competent play would make the ladder describe a
worse player than the one it claims to describe, so the effects stay unscored
until either the horizon rises or somebody finds weights that beat 666. Anyone
revisiting this should re-run the sweep above rather than reasoning about it.

## The horizon no longer fits the game (measured 2026-08-14)

The maze made a floor cost about ten rounds. The scenario still runs for forty.
Nothing re-derived the horizon when exploration landed, and the consequences are
larger than they look.

**Where a run's rounds go**, rule-based and oracle over 24 seeds at 40 rounds:

| phase | rounds | share |
|---|---|---|
| explore | 20.8 | 52% |
| combat | 14.5 | 36% |
| cache | 2.1 | 5% |
| market | 1.7 | 4% |
| camp | 1.0 | 3% |

Half of every run is navigation. That is with the *bots*, which route optimally;
the live model run on 2026-08-14 spent 66 `choose_path` calls against 10 combat
actions over its first 22 rounds.

**The baseline ladder against horizon**, 24 seeds, floor 1, scenario options:

| rounds | random | basic | tactics-only | rule-based | oracle | floors (oracle) | wipes (weak → strong) |
|---|---|---|---|---|---|---|---|
| 40 | 92 | 218 | 577 | 632 | 667 | 4.0 | 4% / 0% / 0% |
| 80 | 120 | 1,052 | 2,148 | 2,353 | 2,629 | 7.5 | 50% / 17% / 0% |
| 120 | 191 | 1,965 | 4,463 | 4,987 | 5,699 | 11.1 | 71% / 29% / 8% |

At forty rounds **no policy ever wipes**. The run ends on the clock, not on
lethality — so the benchmark's central claim, that a run is scored by what the
party accumulated *before it died*, is not what the numbers describe. The
lethality curve only starts acting somewhere past round sixty.

Starting deeper does not fix this. Swept at 40 rounds, `startFloor=20` gives
tactics-only 5,884, rule-based 6,069 and oracle 6,011 — the oracle *below*
rule-based, every policy within half a floor of every other. Depth becomes a
constant added to everyone's score rather than something play earns, and the
gradient the ladder exists to provide collapses.

**Milestone reachability**, 60 seeds at 40 rounds, share of runs clearing each gate:

| milestone | points | basic-tactics | rule-based | oracle |
|---|---|---|---|---|
| mapped-the-floor (rooms ≥ 8) | 4 | 98% | 100% | 100% |
| went-three-floors-down (cleared ≥ 3) | 6 | 38% | 73% | 72% |
| reached-the-boss-floor (reached ≥ 4) | 8 | 38% | 73% | 72% |
| put-down-a-boss | 10 | 3% | 30% | 35% |
| found-a-hidden-way | 4 | 0% | 28% | 28% |
| made-a-route-safe | 4 | 0% | 7% | 5% |
| played-like-a-competent-one (xp ≥ 450) | 10 | 7% | 85% | 90% |

Three problems are visible at once. `reached-the-boss-floor` and
`went-three-floors-down` fire on identical seeds — fourteen points measuring one
thing. `put-down-a-boss` is a coin flip for an omniscient policy, so ten points
turn on luck. `made-a-route-safe` is effectively dead. And `mapped-the-floor`
is free for everybody.

Raising the horizon does not repair the set either: at 80 rounds the same gates
read 90–98% for every competent policy, which discriminates just as poorly in
the other direction. The thresholds are horizon-dependent and were calibrated
for the pre-maze game.

Measured candidates for a 40-round recalibration:

| candidate | basic-tactics | rule-based |
|---|---|---|
| roomsExplored ≥ 18 | 18% | 73% |
| earnedXp ≥ 650 | 3% | 42% |
| floorReached ≥ 5 | 0% | 13% |

`roomsExplored ≥ 18` is the strongest single replacement for the free
`mapped-the-floor` gate; `floorReached ≥ 5` is harder than beating a boss and
should not be used.

**This is a decision, not a defect to be patched silently**, because each answer
costs something different:

1. **Raise `ROUNDS` to ~100.** The game becomes what it claims to be. At the
   observed pace of roughly two minutes per round, a run goes from ~80 minutes
   to ~3.5 hours.
2. **Keep 40 rounds and recalibrate the milestones** to the table above. Cheap,
   internally consistent, and honest — but the scenario then measures the first
   four floors rather than an endless descent, and the documentation should say
   so.
3. **Make floors cheaper in rounds.** Fewer rooms per floor would do it, at the
   cost of the exploration work this roadmap just landed.

Changing any milestone threshold moves the scenario fingerprint and will require
re-publishing the committed comparison cohort.

## A party that acts on 162 turns and still loses (2026-08-14)

A full live run (seed 739530, 200 turns, 40 rounds) finished on the tick limit on
floor 3 with **472 experience** — below `tactics-only` at 506, which is the bot
that fights competently and organises not at all. Five reasoning agents with the
whole toolset lost to a policy with no plan.

The obvious explanation was talking. `room` was the most-called tool at 181
calls, more than `look` and `choose_path` together and nearly three times all
combat actions. **It is not the explanation.** Per-turn co-occurrence:

| turns | |
|---|---|
| chat **and** a game action | 149 |
| chat only, no action | 13 |
| action only | 30 |
| neither | 8 |

`maxToolRounds` is 6 and the party averaged 2.69 calls per turn, so talking rides
along inside a turn rather than consuming one. Splitting information from
progress: **162 of 200 turns moved the game forward**, 17 gathered information
only, 21 did nothing. Roughly a fifth wasted — not enough to explain a 194-point
gap.

The losses are in *action quality*, and the cause is that the game never said the
things a good action depends on:

- **Half the eighteen-ability roster was never used once.** `shield`,
  `shield_slam`, `interrupt`, `sleep_powder`, `vanish`, `cleanse`, `bless`,
  `sanctuary` and `volley` had zero calls in 200 turns. The cleric landed two
  heals in forty rounds and defaulted to `attack` in 10 of 12 combat rounds; a
  mage sat at 25% health for twenty turns while the cleric punched things. The
  guardian never shielded anyone, including the round an ally stood at 8%.
- **Nobody ever retreated**, with `retreats: 0` against a rogue at 10/126.
- **No trap was ever disarmed**, though two were scouted and both were then
  walked into — one by the rogue who had scouted it.
- **`choose_path` blamed the wrong person.** The override message reported the
  *caller* rather than whoever set the pending path, so every override told
  somebody they were replacing their own choice. The party thrashed
  r2→r0→r3→r2→r3 across fifty turns and never learned who to argue with. At tick
  39 of 40 the guardian finally set a course for the stairs; the clock ran out
  one tick before the move resolved.
- **A third of every refusal came from one five-turn window.** A level-up landed
  mid-fight and all five characters reached for `invest_skill` in consecutive
  turns. The refusal named the valid phases and never said the point was not
  lost.

### What landed

Six changes, all text and one real bug, each with a test proved to fail against
the reverted code:

1. `choose_path` names the actual previous chooser, and says so plainly when a
   re-pick changes nothing (one agent re-picked the standing path three times in
   a single turn).
2. A fight now states **your side**: who is hurt, worst first, with anyone under
   25% called out; who is down and that `revive` exists.
3. A character is told **which of its own abilities are castable this round** —
   off cooldown and affordable — and what is cooling down.
4. When the party is losing, the text **names `retreat`** and what it costs. The
   merchant screen already proved that naming an option is what gets it used.
5. Every enemy lookup shares one "that target is gone" message with the living
   refs attached. `useAbility` had this; `attack`, `inspect` and `read_beast` did
   not, so identical mistakes got arbitrary help.
6. A room nobody has scouted says so. The trap itself stays hidden — a per-route
   marker would leak which route is trapped — so the uncertainty is stated about
   the room, which is where it actually lives.

**The baseline ladder is byte-identical** after all six (119 / 217 / 506 / 546 /
666 / 714, spread 595). That is the expected result and the reason it was
checked: bots read `snapshot()`, so a legibility change must not move them. It
also means the ladder cannot tell you whether any of this worked — only a live
run can.

## `bench` measured a game nobody plays (2026-08-14)

`eval bench --simulation descent` swept the *constructor's* defaults, not the
scenario's. The constructor builds a no-maze, no-preparation dungeon so a unit
test can make one in a line. Swept there, the ladder reads:

| | oracle | rule-based | gap |
|---|---|---|---|
| constructor defaults | 1,455 | 1,450 | **5** |
| as the scenario plays it | 714 | 666 | **48** |

Both are true about *a* game. The first says perfect information is worth
nothing, because with no maze there is nothing to know. Nothing in the output
said which one you were looking at.

A simulation now declares the configuration it is played at
(`DESCENT_PLAY_OPTIONS`, registered through `registerSimulation`), the scenario
imports that constant rather than restating it, and `bench` and `rehearse` both
start from it. `--raw-options` sweeps the bare constructor and the header says
which mode produced the table.

This also retires the bolded warning about passing `--maze` to `rehearse`: the
default is now the played configuration, so the trap is gone rather than
documented. Two pieces of viewer work had previously been verified against a
trace whose `floorMap` was null for its entire length.

## The organisation gap was a wall (2026-08-15)

Three defects in floor generation, all of them contradicting a comment written
directly above the code that had them, all measured over the same sweep — 300
seeds × 6 floors, 1,800 generated floors:

| what the generator promised | what it did |
|---|---|
| "Never on the way to the stairs" | **8.2%** of floors put the stairs behind a toll or a locked door |
| "the bidirectional tree remains intact" | **18.3%** had a room the party could walk into and then not reach the stairs from |
| "or the toll would be trivially walked around" | **53.8%** of placed tolls could be walked around |

The first two are soft-locks, and a soft-lock in this simulation is invisible.
It is not a crash: it is forty ticks, no exception, a metrics object full of
zeroes, and a number that lands quietly in the distribution as a hard seed. On
seed 1018 floor 1, the free-reachable set is `{r0, r2}` of seven rooms;
`tactics-only`, `basic-tactics` and `greedy-dps` each stood in those two rooms
for the whole run and scored 0. `bench` reported it as variance.

Causes, in the order they were found:

1. **A barrier is not a route.** `stairsReachableWithout()` walked every
   discovered edge, so "you can still get to the stairs" was satisfied by a path
   through the locked iron door, or through a second toll.
2. **The entrance is not the only place the party can be.** The check ran from
   `r0` only. A one-way drop can land the party on the far side of the gate,
   where the stairs are unreachable even though they were reachable from `r0`.
3. **The toll was placed before the loops.** It reasoned about a tree that no
   longer existed by the time anybody played it — a loop added afterwards could
   reconnect the gated room, and a one-way drop added afterwards could strand
   the party behind the gate.

Landed: the reachability test walks only routes a party can always cross
(`passage`, `trap`, `one-way` — a trap hurts, it does not refuse; a `secret` is
undiscovered and may never be found), and the invariant is quantified over every
room the party can free-walk into rather than over the entrance alone. Toll
placement moved after the loops, the gated room is kept a cul-de-sac so its gate
is the only free way in, and a leaf is preferred over an interior room because
an interior room has two approaches before a single loop is drawn.

All three now measure zero, and the density of *real* gates is unchanged: the
old generator placed a toll on 62% of floors of which 54% were decorative, an
honest rate of 28.6%; the new one places one on 28%, all of them load-bearing.
`src/__tests__/descent-generation.test.ts` holds the invariants, and each of its
three substantive claims was confirmed to fail against the reverted generator.

### What it did to the ladder

| | before | after |
|---|---|---|
| random | 119 | 139 |
| basic-tactics | 217 | 220 |
| greedy-dps | 546 | 630 |
| tactics-only | 506 | **670** |
| rule-based | 666 | 674 |
| oracle | 714 | 705 |
| **tactics-only → rule-based** | **160** | **4** |

`tactics-only` gains 164 points, because it was the row the wall was hitting: it
never pools gold, so a floor whose stairs sat behind a 200-gold gate was a floor
it could not finish. `rule-based` pooled, paid, and walked on. **The gap this
benchmark is built around was substantially a wall rather than a price.**

Two follow-up measurements, so this is not mistaken for a toll problem:

- **Tolls are mildly positive, not negative.** With `rule-based` forbidden to pay
  any toll on identical maps it scores 658 against 674. Paying is worth +16.
- **The gap does not reappear with room.** At 30 seeds: 80 rounds gives
  tactics-only 2,383 and rule-based 2,446 (+63, 2.6%); 120 rounds gives 4,925 and
  5,046 (+121, 2.5%). Organisation is worth about two and a half percent at every
  horizon tried.

So the honest reading of the board is that **the tactical layer is the
benchmark**: `basic-tactics` → `tactics-only` is 450 points, and everything a
party does between fights — buying, trading, pooling, equipping, dividing a
cache, paying a toll, picking a lock, scouting, disarming — is worth 4. The
oracle's hidden-rule memory is worth 31.

`descent-legibility.test.ts` fails on exactly this, with the message it was
written to produce: *"organisation is worth only 4 XP … Something has flattened
the one gap this benchmark exists to measure."* It is left red on purpose. The
assertion is correct and the game no longer satisfies it; making it green by
lowering the threshold would delete the only automated warning that the
benchmark had stopped measuring its own subject.

### The open decision

Restoring a real organisation gap is a design question with at least four
answers, and they are not equivalent:

1. **Make what is behind a gate worth the gate.** A paid cache currently offers
   two extra takes and a paid merchant stocks three floors deeper. Measured
   against a 200–450 gold price and the rounds spent detouring, that is worth
   +16. Raising it is the smallest change and the easiest to overtune.
2. **Make equipment matter.** `tactics-only` spends *zero* gold — it never buys
   anything — and matches a policy that outfits itself completely. That is a
   larger and more interesting finding than the toll, and it points at the
   item economy rather than at the barriers.
3. **Raise the horizon.** Every between-fights investment pays out over time and
   a 40-round run has about fourteen combat rounds. The gap does stay ~2.5% at
   80 and 120 rounds, so this alone does not look sufficient.
4. **Accept it and re-describe the benchmark.** The scenario would then measure
   tactical coordination under asymmetric information, which is a real thing to
   measure and is most of what it currently measures anyway.

Milestone thresholds are deliberately *not* recalibrated ahead of this decision,
because the decision moves the score distribution and doing it twice is worse
than doing it late.

### Measured 2026-08-16: it is option 2, and gold is the reason

Two sweeps, 60 seeds each, on the branch as it stands after the zone, route,
room and identity work.

**First, the ladder has come down but the gap has not come back.**

| rung | 2026-08-15 | now |
|---|---|---|
| random | 139 | 99 |
| basic-tactics | 220 | 158 |
| greedy-dps | 630 | 338 |
| tactics-only | 670 | 488 |
| rule-based | 674 | 502 |
| oracle | 705 | 516 |
| **organisation gap** | **4** | **14** |

A caution about the number in the test message, which currently reads 56: that
is the assertion's own 24-seed sweep, and at 60 seeds the same gap is 14. **The
gap is small enough that a 24-seed estimate is mostly noise**, which is worth
knowing before anybody reads a run-to-run move in it as progress.

**Second, and this is the finding: gold has no marginal value.** `rule-based`,
the policy that uses the economy best, 60 seeds, identical maps, sweeping only
what it starts with:

| starting gold | skill points | XP | gold spent | wiped |
|---|---|---|---|---|
| 0 | 0 | 417 | 25 | 40% |
| 0 | 2 | 482 | 36 | 43% |
| 180 | 2 | **502** | 787 | 43% |
| 400 | 2 | 488 | 1,164 | 40% |
| 900 | 2 | 487 | 1,164 | 40% |
| 900 | 6 | **577** | 1,202 | **8%** |

Read the columns against each other:

- **751 more gold spent buys +20 XP** (0 → 180), and the next 377 buys **−14**.
  Above 180 the curve is flat to slightly negative, and spending caps at ~1,164
  regardless of purse — the merchant's stock is the ceiling, not the money.
- **Two skill points are worth +65 XP** on their own, with no gold at all, and
  six take it to 577.
- **Equipment does not change whether the party lives.** Five times the gold
  moves the wipe rate 43% → 40%. Four extra skill points move it 43% → **8%**.

That is the causal chain the gap was hiding. **Organisation in this game is
denominated in gold** — pooling purses, transferring coin, dividing a cache,
trading an item to whoever can use it are the organisational acts, and every one
of them moves gold or items. Gold buys nothing, so organisation is worth nothing.
The gap is not flat because coordination is easy; it is flat because the currency
coordination is conducted in has no purchasing power.

This retires option 1 rather than answering it: making what is behind a gate
worth the gate means putting *more gold and items* behind the gate, and the sweep
says the party could already buy more than it can use. It also sharpens option 2
from "make equipment matter" into something testable — the talent economy already
produces exactly the effect the item economy is supposed to, on the same policy,
in the same runs. Whatever makes a skill point worth 32 XP is what an item needs.

Not fixed here. Rebalancing the item economy changes every score in the ladder
and every milestone threshold, and that is your call, not a side effect of a
measurement.

## The difficulty ramp is a function of where the run ends (2026-08-15)

Every run ending on the clock is the defect. Raising the ramp is the obvious
repair and it does not work, for a reason worth writing down before anybody
tries it again.

**The curve cannot act inside the window the run occupies.** Damage compounds at
5.5% per floor, drawn for a run that ends around floor 48. The maze made a floor
cost about ten rounds, so a forty-round run reaches floor four — where 5.5%
compounding has produced a dungeon **17% harder** than floor one. Nothing dies to
17%.

Measured wipe rates for `rule-based`, 40 seeds at 40 rounds, sweeping only the
damage base:

| base | floor-4 multiplier | wipes |
|---|---|---|
| 1.055 (shipped) | 1.17× | 0% |
| 1.30 | 2.20× | 5% |
| 1.50 | 3.38× | 10% |
| 1.80 | 5.83× | 30% |
| 2.20 | 10.6× | 88% |

**The rate is the wrong thing to tune on.** A curve can produce deaths and still
be bad. Over eighty rounds at 1.50, `rule-based` wiped 87% against
`tactics-only`'s 73% — the *better* policy died more often, so the ending had
become a lottery. At 1.35 the same sweep reads basic-tactics 73%, tactics-only
50%, rule-based 37%, oracle 23%: lethality ordered by competence, which is the
property actually worth having, and death rather than the clock ending the run.

So 1.35 is the value the shallow game wants. It is not shippable, and the tree
says so in six places at once.

**What blocks it: the deep configuration.** `startFloor=31` is a supported
configuration and six tests protect it — encounter length, the healer-at-the-
bottom ordering, a ≥20,000 spread, the oracle's memory premium, and a pacing
check that a forty-round run clears at least three floors. At 1.16 the deep game
already fails all of them: spread collapses from over 20,000 to 6,594, a
forty-round run clears **zero** floors, and `greedy-dps` overtakes
`basic-tactics`. At floor 31 the difference is not subtle — 1.055³⁰ is 5.0×
where 1.16³⁰ is 90×.

That is not a tuning problem, it is the shape of the thing: **the curve is
anchored at floor one and monotone, so there is no base that makes floors one to
five dangerous and leaves floor thirty-one where it is.** The shallow game and
the deep game want different curves from one constant.

### The decision

1. **Anchor the ramp to the run's start floor** — scale by `floor - startFloor`
   rather than `floor - 1`, so a party that begins at 31 meets the same relative
   curve as one that begins at 1, with absolute strength still carried by the
   family tiers at that depth. This is the only option that gives both
   configurations a real ramp, and it is a redesign rather than a constant.
2. **Retire the deep configuration** and re-derive the six tests against a
   shallow-only game. Cheapest, and it throws away `startFloor` as a knob —
   which the roadmap already found to be a poor measurement anyway (at 40 rounds
   `startFloor=20` puts the oracle *below* rule-based).
3. **Fix the pacing instead.** A floor costs about ten rounds and half of every
   run is navigation; at four rounds a floor, a forty-round run would reach
   floor ten and the shipped curve would bite on its own with nothing retuned.
   Explicitly deferred once already, and this measurement is the argument for
   picking it back up.

Nothing was shipped. The damage base is unchanged at 1.055 and the sweep above
is the whole of what this produced, because a ramp that breaks six deep-game
invariants is not "a bit faster", and choosing between the three options above
is a design call rather than a calibration.

One thing found on the way, worth its own line: **no policy ever retreats.**
`retreats` is 0.00 across every baseline at every ramp tested, including 2.20
where 88% of runs wipe. A party that never withdraws cannot be made to survive
by any difficulty curve, so some of the lethality measured above is really the
baselines refusing to use an escape hatch the simulation offers them.

## What two log reviews found (2026-08-15)

Two independent passes over the recent traces — one reading only the narration
(no source), one aggregating the raw NDJSON — agreed on more than they disagreed
on. Nothing below is fixed yet; it is the list to work from.

**Half of every class's kit is dead weight.** 15 of the 48 tools are never called
once across ~850 calls and 18 combat rounds in two runs: `shield`, `shield_slam`,
`interrupt`, `sleep_powder`, `vanish`, `pick_lock`, `bless`, `sanctuary`,
`volley`, `read_beast`, `frostbite`, plus `retreat`, `revive`, `unequip` and
`choose_name`. It is concentrated rather than spread — the guardian never shields
anybody, the rogue never interrupts or vanishes, the cleric only ever heals, and
the mage casts lightning 12 times against 2 fireballs and no frost. The
legibility wave already made a character's castable abilities explicit each
round; this says it did not work, and the next attempt should probably make the
*situation* name the ability rather than listing what is off cooldown.

**Simultaneity wastes about one action in nine.** Nine narrated rounds across two
runs end with several characters hitting a corpse — worst case four of five in
one round. This is the mechanic working as designed (actions are readied, the
round resolves at once) but nothing tells the party that a target is already
dead-in-expectation, and the narrator has no other way to describe it, which is
why "swing at empty air" appears nine times in eighty rounds.

**`divided-a-cache` fails identically on two different seeds and rosters.**
`cacheTakers` is 1 in both runs, so the 8-point milestone that says a
conversation happened has never been earned by a live party. The Spoils panel
now at least makes the cache visible to a *viewer*; making it visible to the
party is separate work.

**A revive needs an item nobody knows to buy.** One 96-damage reflect killed the
mage on floor 3, and the party then discovered there was no soul stone to bring
them back — three rounds of stalling, an abandoned floor, and the 8-point
`nobody-was-left-behind` milestone lost. The requirement only becomes visible
after the death, which makes it unpreparable rather than difficult.

**One agent silently skipped 17.5% of its turns.** In the 3.6 run the mage
produced zero tool calls — not even a `room` pass — on 7 of its 40 turns, against
1 of 40 for the ranger and 0 for everyone else. Agent-specific, not evenly
distributed noise, and worth a look at whether those turns errored.

**Duplicate posts inside a single turn.** Five times across the two runs, an
agent sent the same 600–750 character message twice in one turn, differing only
by a redundant `room` key in the arguments — so a naive same-tool-same-args check
does not catch it.

**The two models talk in opposite ways.** `room` is 41–46% of all calls in both,
but 3.6 used it to pass in silence 77% of the time while 3.8 posted 78% of the
time. Refusals also differ: 5.9% for 3.6 against 2.6% for 3.8, with 3.6's
dominated by phase errors (`invest_skill` mid-combat) and exhausted skill points.

One caveat recorded because it looked like a finding and is not: the 2026-08-15
trace has no `end` event and stops mid-round. That run was stopped by hand to
free the GPU, not by a crash.

## Correctness and benchmark safeguards

Every tranche should include:

- deterministic same-seed/same-decisions tests;
- different-seed variation tests;
- trace ordering and broadcast deduplication tests;
- scene-contract validation between simulation and browser;
- illegal-phase, invalid-target, and self-transfer tests;
- baseline sweeps at the scenario's real options and horizon;
- milestone reachability checks;
- explicit configuration fingerprints for historical comparisons;
- performance checks for long baseline sweeps and repeated browser snapshots.

No feature should be accepted solely because it looks interesting in one run.
It must either create a measurable decision, make the broadcast clearer, or
increase controlled variation without degrading reproducibility.

## Suggested implementation sequence

1. **Complete:** introduce item instances and foundational affix generation
   behind compatibility helpers.
2. **Complete:** add detailed item/build data to the scene contract and the
   active-character broadcast panel.
3. **Complete:** add the first unique item effects and teach baseline policies
   how to value the simple subset.
4. **In progress:** escaped encounters, room-owned rewards, threat visibility,
   exploration metrics, one-way drops, traps, secret shortcuts, locks, keys,
   and persistent room hazards are complete; add secret rooms and more
   destructible or class-specific routes next.
5. **Complete:** add seeded character identity, personality, public aspirations,
   private motives, information boundaries, and their broadcast presentation.
6. **Complete:** zone-specific stage themes and room staging, plus the page's
   own visual identity (see [broadcast-viewer.md](./broadcast-viewer.md)).
7. **Complete:** historical ghost comparisons with strict cohort matching, and
   the trace now records the configuration a run played so two configurations
   can be told apart at all.
8. Expand talents into active/passive rule changes.
9. Add events, minibosses, hazards, and optional floor objectives.
10. Re-run large baseline sweeps, recalibrate milestones, and update benchmark
   documentation and committed comparison cohorts.

## Deferred ideas

- Splitting the five characters into separate communication rooms remains a
  possible scenario variant, not a default change. It would confound dungeon
  play with cross-room message routing in the current benchmark.
- Permanent meta-progression between benchmark runs is out of scope because it
  would make runs incomparable. All progression should begin and end within one
  seeded run.
- Unseeded randomness is out of scope. Variation must remain reproducible for
  debugging, grading, narration, and broadcast replay.
