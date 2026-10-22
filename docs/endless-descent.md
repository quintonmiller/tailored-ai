# The Endless Descent — workstream record

What this is, why it exists, what has been decided, and what is worth doing
next. The mechanics live in [docs/evals.md](./evals.md#endless-runs-a-simulation-with-no-win-condition-at-all)
and the viewer in [docs/broadcast-viewer.md](./broadcast-viewer.md); this page is
the arc of the work and the reasoning behind it.

## The problem it was built for

Every scenario in the benchmark before this one asks whether a team can reach a
state somebody wrote down in advance, and each of them is now finished:

| scenario | result |
|---|---|
| `the-machine` | 98/98, three runs of three |
| `the-machine-across-a-divide` | 32 / 52 / 107 out of 107 |
| `the-lock` | proved solvable and soft-lock-free; solved on run 3, and every run after |

`the-lock` took a full session to author, with an exhaustive prover behind it,
and was beaten within four runs. That is the structural problem: **a benchmark
with an answer has to be re-authored every time it is beaten, and each
replacement costs a session and buys one bit of information.**

The pair in the middle of that table is also the most useful measurement the
package has produced. They are the same fifteen-step puzzle; the only difference
is that the room is cut in half. **Difficulty in a multi-agent scenario comes
from the shape of the team, not the length of the chain.** Everything here is
built on that.

## The proposal, and what changed

The design came from Quinton: a deterministic, tool-driven cooperative roguelike
scored on total experience, ending when the party is wiped. Classes with
asymmetric abilities and information, trading, individual gold, shops, turn-based
tactical combat, partial observability, hidden enemy mechanics learned by
experiment, branching exploration, scarce consumables, death and resurrection,
seeded worlds, baseline bots, and a diagnostic breakdown alongside the score.

Almost all of it shipped as proposed. Five deliberate departures:

1. **Combat actions are readied, not taken.** A tool call queues an intent and
   the whole round resolves together. If actions resolved as they were called,
   the second agent to act would see the first one's result and the party would
   coordinate for free by taking turns — there would be no way for the mage to
   fireball a group the rogue has just put to sleep, which is exactly the failure
   worth catching.
2. **Packs and purses are private.** `look` shows an ally's health and what they
   are wearing, never their inventory or gold. This is what turns "the plate
   landed on the mage" from a bookkeeping error into a conversation somebody has
   to start.
3. **One room, and no intercepted party channel.** `the-machine` and its split
   sibling already measure what happens when a fact must cross a wall. Splitting
   the party too would make a low score ambiguous between "could not play the
   dungeon" and "could not get a number across a room". The intercept mechanic
   was dropped because its optimal play is "never use the shared channel", and
   the real cost of over-posting — context budget — is already real.
4. **No in-game bestiary.** There is no `recall_lore` tool and no lore store. One
   would measure whether a model can use a lookup table; the point is to measure
   whether *the framework's* memory survives a run longer than a context window.
5. **The party starts mid-descent.** Forced by measurement — see below.

## Where it stands

**Built and verified.** The simulation, a six-rung baseline ladder, seven
diagnostics, the scenario, a broadcast viewer, an observer-only narrator, and a
bot rehearsal mode for developing against. 631 tests, both typechecks clean.

**The ladder, full-length runs, 24 seeds** (after the 2026-08-13 pacing fix —
see [endless-descent-improvements.md](./endless-descent-improvements.md)):

| policy | earned | floor | wiped | what it adds |
|---|---|---|---|---|
| `greedy-dps` | 1,980 | 10.3 | 100% | all damage, no healer |
| `random` | 6,253 | 17.2 | 100% | legal moves, chosen without a thought |
| `basic-tactics` | 15,174 | 24.8 | 83% | taunt, heal, swing |
| `tactics-only` | 29,447 | 34.5 | 46% | plays the fight well, ignores everything else |
| `rule-based` | 46,505 | 42.5 | 63% | everything a competent player does |
| `oracle` | 76,414 | 53.1 | 42% | and knows every hidden mechanic already |

A 39× spread, and **monotonic** — every rung now outscores the one below it,
which the pre-fix ladder did not manage (`greedy-dps` beat `random` by dying
faster in a game where nothing killed you inside the horizon). The out-of-combat
layer is worth **+58%** on top of playing every fight well; perfect recall is
worth **+64%** beyond that, and ten more floors.

Every policy now wipes eventually, which is the design working: the run is meant
to end because the party dies, not because the clock ran out. Before the fix,
nothing above `greedy-dps` died at all inside a forty-round window — the curves
that crossed were health against damage, producing a stalemate, rather than
lethality against health, producing an ending.

**Agent runs so far** (`qwen3.6-27b-vllm`, one repeat each, 40 rounds):

| | run 1 (floor 30) | run 2 (floor 31) |
|---|---|---|
| earned | 6,550 | 2,883 |
| milestones | 50/100 | 38/100 |
| ended | wiped, floor 31 | wiped, floor 34 |
| tool correctness | 92% | 89% |

Both land between `random` and `tactics-only` on the same seed, and both are the
only results in that band that wipe — `basic-tactics` earns comparably and keeps
all five alive. There is roughly 2.5× of headroom above them.

**What the diagnostics say, consistently across both runs:** the fighting is not
the problem. Run 1 finished holding 17,180 gold having never visited a merchant;
neither run ever moved gold or an item between members; ten deaths and zero
revives with a soul stone in the ranger's pack from tick one; and the guardian
reads an enemy's armour aloud and the party then makes physical attacks into it
16 times in run 1 and 30 in run 2.

## Decisions and trade-offs

### Baselines before a single model call

The most valuable decision in the workstream. Six scripted parties were built and
tuned before any agent ran, and they found four balance defects that would each
have cost hours of model time and been misread as an agent failure:

- The floor-5 boss carried more flat armour than the whole party's attack power,
  so every physical attack did exactly 1 and every baseline died there regardless
  of play.
- Nothing regenerated mana, so the casters were spent by floor 3.
- Hidden mechanics did not scale with depth, so an 18-point detonation on floor
  40 was a rounding error and **the oracle finished behind `rule-based`**. If
  perfect knowledge does not beat no knowledge, the memory diagnostic is
  measuring nothing.
- The ladder had a hole: everything died by floor 8 or reached floor 40, with
  nothing in between, so a mid-table agent run could only be described as "better
  than random".

The oracle is what made the third one visible, and it is the argument for
building an omniscient baseline even though nothing will ever play like it.

### Armour is small and flat; the walls are resistances

Flat armour subtracted from a growing attack is either irrelevant or absolute,
with very little in between. "Immune to swords" is a resistance now, because a
multiplier scales with the number it modifies instead of outrunning it.

### The score is `earnedXp`, never `totalXp`

A party started on floor 31 is handed ~23,000 experience for standing there.
Scoring on the total would have passed every threshold in the scenario on tick
zero. This bit twice — once in the scenario's own thresholds, once in a
`pooledPurchases` heuristic calibrated against a floor-one opening purse, which
fired on every ordinary purchase and awarded an agent run ten milestone points
for shopping. **A threshold calibrated against the opening state is wrong for any
scenario that does not start at the opening state.**

### Starting on floor 31 rather than floor 1

Measured, not chosen. A 40-round run from floor 1 reaches about floor 11, and
floors 1–22 are survivable by a party playing *randomly* — every rung from
`tactics-only` up finished within 15% of every other, because nothing that
separates them has happened yet. Floor 30 was tried first and is a boss floor
(divisible by five), which put the hardest fight in the rotation before anybody
had agreed on anything and compressed the ladder to a 2.3× spread. Floor 31 gives
3.7×.

The cost is that the agents never see floors 1–30 and never learn the families
organically. That is the trade being made, and `startFloor: 1` with ~150 rounds is
two numbers away.

### The broadcast must not change what is measured

A run's numbers have to be identical whether or not anybody was watching, or
every comparison against a run made in private is invalid. So the page is a pure
reader, extra data is additive, and **the narrator is a separate process** that
reads the trace and writes a sidecar. It can be started, stopped or killed at any
point with no effect on the run at all. It is a command rather than a flag on
`run` specifically so that forgetting to disable it cannot contaminate a
benchmark.

### The viewer took a build step

The developer viewer at `/` is one file with an inline script and re-reads per
request, which makes editing it instant. The broadcast is eight modules and
~7,500 lines, which is past the point where "no build step" stops being a
simplification and starts being an argument for leaving it untyped. Full
TypeScript with esbuild, at the cost of a compile between edit and reload.

`tsc` runs separately from the bundle because **esbuild strips types without
checking them** — bundling alone would ship a type error silently.

### The scene is declared twice and checked once

The browser compiles with `lib: ["DOM"]` and `types: []`; importing the
simulation to reach one interface would give the page a dependency on the thing
it is only supposed to be watching. So the shape lives in a leaf file with no
imports, and `src/sim/descent/scene-check.ts` asserts at compile time that the
simulation's `DescentScene` is exactly it, in both directions.

## What it cannot tell you yet

- **The memory dimension is thin at this budget.** Forty rounds is about six
  floors, which yields roughly one opportunity per run to show a family's rule
  was remembered. The measurement exists and is live; it is not yet producing a
  number worth ranking on.
- **The top three rungs are within 5% of each other** at 40 rounds. The economy
  and perfect recall both pay off over floors. This configuration resolves the
  *bottom* half of the ladder well, which is where agent runs currently land.
- **N=1.** Both agent runs are single repeats. This scenario's run-to-run noise
  floor is unmeasured; `the-lock`'s was 2.6 points at three repeats, and nothing
  here should be read as a 2-point difference meaning anything.
- **Model priors are a confound.** A model that has read a lot of RPG strategy
  has an advantage unrelated to the framework. Unfamiliar family names mitigate
  it; they do not remove it. Always read a score against the ladder rather than
  in absolute terms.
- **The diagnostics detect anti-patterns, not sub-optimality.** For `the-lock` an
  optimal line could be written down because the state space is small enough to
  search exhaustively. Here it cannot be, at any tractable cost, so every reading
  comes from an event the simulation can see itself.

## Ways to improve, in the order the evidence supports

> Superseded by [endless-descent-improvements.md](./endless-descent-improvements.md)
> (2026-08-13), which reviews the viewer, the theme and the game itself, and
> leads with a pacing defect measured during run 3: nineteen of the first
> twenty-four rounds were a single fight, so most of the list below is starved
> before it starts. The items here remain accurate about *measurement*; read
> the newer document for the ordering.

1. **Run the full arc.** `startFloor: 1` and ~150 rounds. This is the single
   change that unlocks both weaknesses above: the memory measurement gets enough
   recurrences to rank on, and the top three rungs separate. It needs the
   scenario schema's 40-round cap raised (a validation bound, not behaviour) and
   costs roughly three hours a run.
2. **Repeats, and a noise floor.** Three repeats across several seeds, to
   establish what a meaningful difference is for this scenario. Everything
   reported so far is a single sample.
3. **Assert against the ladder, not a constant.** The scenario's `expect` block
   hardcodes an experience threshold that has already been re-derived twice as
   the balance moved. `beats_baseline` exists in the grader and would make the
   scenario say what it means: *beat `basic-tactics` on the same seed.*
4. **A split-party variant.** The measured 40-point lever from `the-machine`,
   applied here — the front line in one room, the casters in another, with
   `inspect` results that have to cross. Belongs in a second scenario so the two
   measurements stay separable.
5. **Private incentives.** Quinton's variant: a small personal objective per
   agent against a mostly-shared one. Expect it to be confounded by models being
   trained toward cooperation, but it is cheap to try.
6. **Real Twitch ingest.** The chat panel and its adapter seam exist; nothing
   connects them to an IRC feed. Deliberately unbuilt rather than faked.
7. **More content at depth.** Ten families and four bosses is enough for a run
   ending in the thirties. A run reaching floor 60 will see the same rotation
   twice.

## Known rough edges

- Run 1's trace predates the fix that put metrics into `snapshot()`, so it shows
  no score in the broadcast's scoreboard. Correct, and worth knowing before it
  reads as a bug.
- The stage's beat animation has been exercised against bot rehearsals and
  finished traces. Its first live workout is run 3.
- `results/rehearsals/` is deliberately outside the scoreboard's reach. Anything
  written into `results/traces/` by hand will be counted as a real run.

## Where the pieces live

| what | where |
|---|---|
| rules, combat, statuses, beats | `packages/evals/src/sim/descent/model.ts` |
| bestiary, bosses, items, scaling | `packages/evals/src/sim/descent/content.ts` |
| the seven diagnostics | `packages/evals/src/sim/descent/diagnostics.ts` |
| tools, phases, prose, metrics, scene | `packages/evals/src/sim/descent/index.ts` |
| the six baselines | `packages/evals/src/sim/descent/policies.ts` |
| the scenario | `packages/evals/scenarios/23-the-endless-descent.ts` |
| broadcast page | `packages/evals/viewer/broadcast/` |
| narrator | `packages/evals/src/narrate.ts` |
| run history / scoreboard | `packages/evals/src/history.ts` |
| bot rehearsals | `packages/evals/src/rehearse.ts` |

```bash
pnpm run eval -- bench --simulation descent --seeds 24 --days 400   # the ladder, no model
pnpm run eval -- rehearse --policy rule-based                       # a trace from a bot
pnpm run eval -- rehearse --simulation descent-betrayed --policy investigator \
  --sim-option reveal=social --sim-option traitors=1                 # the social layer, no model
pnpm run eval -- watch                                              # /  and  /broadcast
pnpm run eval -- narrate --home ~/.tailored-ai                      # commentary, from outside
pnpm run eval -- run --filter the-endless-descent --max-scenario-minutes 240
```
