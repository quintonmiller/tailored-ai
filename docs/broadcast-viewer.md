# The broadcast viewer

A second page over the same trace, built to be *watched* rather than read.

> Part of [the Endless Descent workstream](./endless-descent.md), which carries the
> context and the open questions. This page is the viewer itself.

`eval watch` already serves a developer viewer at `/`: dense, filterable, three
columns of text, built to diagnose a run. It is the right tool for finding out
why a party died and the wrong one for showing anybody what happened. This is
the other page — `/broadcast` — and its job is that a person with no context can
look at it and follow a fifty-minute run.

The reference point is Twitch Plays Pokémon, with the awkward difference that
nobody has built us a Pokémon. The game, the sprites, the map and the commentary
all have to come from the same trace the benchmark already writes.

## The one rule everything else follows

**The broadcast must not change what is measured.**

A run's numbers have to be identical whether or not anybody was watching. That
is not a stylistic preference — the whole package exists to produce comparable
figures, and an observer that costs tokens, adds turns or perturbs the model
would quietly invalidate every comparison against a run made without it.

Three consequences, and they shape the architecture:

1. **The page is a reader.** It polls `/events` and renders. It never posts,
   never calls a tool, never reaches the agent loop.
2. **The narrator is a sidecar.** It is a model, and a model that watches costs
   tokens. It runs as a *separate process* against the trace file and writes
   `<trace>.narration.ndjson` beside it. A run is byte-identical with or without
   it, and `--trace off` disables both.
3. **Extra data is additive.** The simulation grew a `scene` object and the
   resolver grew `beats`; nothing existing changed shape. `snapshot()` stays
   metric-shaped because live milestone scoring reads it as a run's metrics.

## Starting one

Three processes have to agree on one file, and two of them default to "whatever
trace is newest" — which, in the seconds before a run creates its own, is the
*previous* run. One script starts them together and hands all three the same
path:

```bash
packages/evals/scripts/descent.sh                    # play, with commentary
packages/evals/scripts/descent.sh --seed 3301        # play a particular dungeon
packages/evals/scripts/descent.sh --rehearse rule-based   # no model, ~20s
packages/evals/scripts/descent.sh --replay <trace>   # re-open a finished run

# a different model, at a named reasoning effort
packages/evals/scripts/descent.sh --model qwen3.8-27b-vllm \
    --thinking high --thinking-dialect vllm_effort
```

It prints the broadcast URL and the seed it chose, and Ctrl-C stops all three.

Three things in it are load-bearing rather than convenient:

**`--thinking` is refused unless the dialect can carry it.** The `vllm` dialect
sends one boolean, so every enabled level is the same request and the chat
template's own default decides the effort — asking for `medium` against it
yields a run at the template default and a report that says `medium`. That is
how every Qwen3.8 number before 2026-08-15 came to be an `xhigh` number. The
script reads the dialect the run would actually use (from the flag, else the
target's home config) and dies with the fix rather than mislabel four hours of
play. See `docs/agent-loop.md`, "Reasoning".

**`--trace` on a run is a base path, not a filename.** The harness writes one
file per scenario and derives each name by inserting the scenario id before the
extension, so `--trace results/traces/x.ndjson` produces
`x.the-endless-descent.ndjson`. Point the page at the base and it watches a file
nothing ever writes.

**A run against a dead model does not fail.** It plays its whole horizon, makes
no tool calls, and reports a zero — which is indistinguishable from a party that
played badly unless you look at the trace. After a reboot that is the default
state of the box, and it has already cost one full run. So the script checks the
router is answering before it starts, and then watches the trace for the first
`call` event and says plainly if none arrives.

## Everything the snapshot counts

The store keeps `state.stats` — every numeric field riding on the same snapshot
as the scene — and `state.previousStats` beside it. It used to keep only
`snapshot.scene` and drop the rest, which is why the HUD grew a `makeTally()`
that reconstructs floors, bosses and deaths by diffing scenes. That
reconstruction is still there as a fallback for older traces, but the
simulation's own counter wins wherever it exists: a scene diff cannot tell a boss
killed from a boss escaped, and the counter can.

Roughly sixty counters arrive this way — `enemiesDefeated`, `elitesDefeated`,
`goldTransfers`, `tollsPaid`, `secretRoutesFound`, `backtracks`, `misheldTicks`,
and the `diag*` axis scores among them. The tiles show eight; the rest are one
lookup away.

## Every tool has a sentence

`vocabulary.ts` holds the phrase and stripe tables, split out of `feed.ts`
because they are data and because `feed.ts` reads `window` at module load, so
nothing in Node could check them. A test now walks the tools the simulation
actually registers and fails on any that would fall through to the generic
renderer.

That test exists because four went missing at once — `pay_toll`, `pick_lock`,
`breach_route` and `disarm_trap`, the entire consequential-route family — and
each drew as flat grey text at the visual weight of a `look`. Nothing failed.
The fallback renderer is deliberately forgiving so a new ability degrades to a
dull line rather than a blank one, and the cost of that kindness is that a
missing entry is invisible. A two-hundred-gold toll gate read as background
chatter for as long as the mechanic existed.

## What the data looks like

Three sources, all already served by `eval watch`:

| endpoint | what it gives |
|---|---|
| `GET /events?since=N` | the trace from cursor `N`: `run`, `round`, `turn`, `call`, `post`, `state`, `progress`, `end` |
| `GET /history?scenario=X` | every past run on disk: best ever, previous, today, this week |
| `GET /narration?since=N` | commentary, when a narrator has been run |

The `state` event carries `snapshot.scene`, which is the structured half:

```
scene = {
  floor, phase, tick, horizon, dread, level, earnedXp,
  party:   [{ id, hp, maxHp, mana, maxMana, gold, dead, statuses[], pack[], worn[], readied }],
  enemies: [{ ref, name, family, hp, maxHp, elite, boss, statuses[], telegraph }],
  paths:   [{ id, label, kind, hint }],  pendingPath, scouted,
  stock:   [{ id, name, price }],        loot: [{ id, name, to }],
  beats:   [{ kind, from, to, amount, element, note }],   // last round, animatable
  beatsTick,                                              // which tick they belong to
  log:     [ "rogue hits The Hollow Choir for 89", ... ]  // last round, readable
}
```

One trap worth stating plainly, because two modules found it independently: the
harness writes a `state` event after every **turn**, so one round of five agents
publishes five snapshots carrying the *same* beats. Anything that animates or
counts them must dedupe on `beatsTick`, or it throws the same sword five times
and reports five deaths for one. For the same reason `/history` includes the
trace being written right now — a "record to beat" that included the current run
would sit pinned at 100% for the whole run, so it is filtered by filename.

`beats` is the important addition. The prose in `log` is what an agent reads; a
renderer that had to regex `"rogue hits X for 89"` to throw a sprite would break
the first time somebody reworded a verb. Every damage, heal, shield, status and
death emits a record from the same choke point that applies it.

## Layout

Sixteen by nine, three columns, designed to be legible at streaming bitrates —
which mostly means large type, few simultaneous moving things, and no
information that is only conveyed by a two-pixel colour difference.

```
┌────────────────────────────────────────────────────────────────────┐
│  THE ENDLESS DESCENT   floor 34 · round 28/40 · 3 standing ·       │
│                        dread 12 · best 9,414                       │
├────────────┬────────────────────────────────────┬──────────────────┤
│   MAP      │                                    │    NARRATOR      │
│  (always)  │             STAGE                  │                  │
│            │  (room, party, enemies, hits,      ├──────────────────┤
├────────────┤   damage numbers, speech)          │                  │
│  RECORDS   │                                    │    ACTIVITY      │
│   ⇅        ├────────────────────────────────────┤  what they said  │
│  PROGRESS  │   READIED THIS ROUND               │  and what they   │
│            │  (five lanes, clashes lit)         │  did, one clock  │
│            ├────────────────────────────────────┤                  │
│            │          PARTY HUD                 │  (never cut      │
│            │  (five bars, statuses, readied)    │   away from)     │
├────────────┴────────────────────────────────────┴──────────────────┤
│           Made by Quinton Miller · Powered by Tailored AI          │
└────────────────────────────────────────────────────────────────────┘
```

**Three things never rotate: the stage, the map, and Activity.** The map used to
share the left slot with everything else, and that was wrong — "where are they
and what is left of this floor" is a question a viewer has continuously, not
once every fourteen seconds, and somebody who looks up mid-fight to find a
milestone ladder where the map was has to wait out a rotation to get their
bearings back. Only Records and Progress rotate now, and both are context rather
than news.

### Activity: said and did, on one clock

The party channel and the event log were separate panels, and the split was the
problem. An argument about who takes the second thing out of a cache happened in
one box and somebody taking it happened in another, so a viewer had to hold the
join in their head — and for most of a run the log was showing a one-line
truncated quote of the very message the channel above it was showing in full.

Interleaved, a decision and its consequence are adjacent, which is the only
reading of a run that explains anything. Speech renders in full, actions render
as a marked row, round rules separate them, and the merge cost nothing: `feed`
already carried `say`, `call`, `round` and `end` on one timeline.

### Identifiers are expanded, not rewritten

The party talks in identifiers because the tools take identifiers:

> `@rogue take vitality_ring@0004 to r3, beast-1 is the one with armour`

Every token there is load-bearing and none of it is language. So the transcript
keeps the identifiers and **the page expands them** — `viewer/broadcast/src/names.ts`
matches four unambiguous shapes (`@class`, `base@serial`, `family-n`, `rN`),
looks each up in the lexicon the feed already builds from the scene, and renders
a coloured chip carrying the display name with the raw token on hover.

Asking the agents to write prose instead would trade tool accuracy for
readability, which is the wrong way round for a benchmark — and it would mean
the text on screen was no longer the text that was sent. An identifier the
lexicon has never heard of is left exactly as typed, because a page that guessed
would be inventing a name the run never had.

### The floor map is drawn from the graph, not from the generator's coordinates

The map was rebuilt rather than tuned, because both halves of how it worked were
wrong.

**The coordinates were never a layout.** Generation grows the room tree with
`x: parent.x + rng.int(-1, 1)`, `y: parent.y + 1` — those numbers exist to give
the simulation a sense of depth, not to be drawn. Two children of the entrance
can be handed the same cell and land exactly on top of each other.

**Straight lines between centres were never corridors.** A loop or a one-way
drop connects rooms nowhere near each other, so its line cut diagonally across
the picture and passed through unrelated rooms — a corridor going through a wall
into a room it does not connect to. On a plan of a floor that is not a
stylisation, it is a lie about the floor.

Measured over 600 generated floors, the old drawing had **380 rooms sharing a
cell, a corridor through a room on 599 of them, a diagonal on all 600**, and —
worst of the four — it drew the floor's concealed shortcut on **563** of them,
because it read `routes` while a room's `links` is what says *discovered*. The
broadcast was showing the audience a secret the party had not found.

`viewer/broadcast/src/floorplan.ts` now computes the layout itself and ignores
`x`/`y` entirely: rooms go in rows by breadth-first distance from the entrance,
get ordered inside a row by two barycentre sweeps so connected rooms sit near
each other, and every corridor is routed orthogonally. The one rule the router
is built on is that **a corridor is only ever horizontal inside a gutter** —
a horizontal run at room level passes through every room between its endpoints,
which is the original defect. Two shapes come out of it: a *hop* through the
shared gutter for neighbours, each in its own lane so hops nest rather than
overlap; and a *bracket* out to a side channel for anything two or more rows
apart, which visibly goes around.

It is pure and has no DOM, which is the point — `src/__tests__/floorplan.test.ts`
asserts no two rooms share a cell, no corridor passes through a room, every
segment is orthogonal, an undiscovered corridor is not drawn, and the same floor
draws identically twice, over every floor of a hundred seeds. Each claim was run
against the old coordinate layout first and fails there.

### Spoils: the two decisions the page could not see

`scene.cache`, `scene.cacheTakesLeft`, `scene.cacheOrigin` and `scene.stock` all
crossed the contract and were rendered **nowhere**. The stage drew a cache room;
the HUD counted the stock into a single number. So a viewer watching the party
argue for four rounds about a cuirass had no way to know there was a cuirass, and
the run's most-discussed decision looked from outside like five people talking
about nothing.

The Spoils panel shows a dead expedition's six items with who each is for and
who has claimed it, the takes remaining as a number *and* as pips — it is a hard
cap, and pips read as a thing running out where a count reads as a score — or,
at a merchant, the stock with prices. It states one derived fact nobody has to
work out: **how many items cost more than anybody is carrying**, and what the
five purses hold between them. That is precisely the condition `give_gold`
exists for, and the party misses it about as often as it finds it.

It is the only panel the left column interrupts for. Everything else over there
is standing context; a cache appears, has a hard cap, and is gone in a few
rounds.

### Type, and what had to go to make room for it

The side columns were fixed at 270 and 320 CSS pixels — a fair measure on a
laptop and a ribbon on a television — which is why the type in them had been
driven down to 9 and 10 pixels to fit. Seventy of the page's ninety-eight font
declarations were 11px or smaller.

Both columns are now proportional with a floor, and every size moved up a hand-
set ramp (5→8, 9→12, 11→13, 13→15) rather than a multiplier, because the bottom
of the scale needed the most help and the top needed none. Two things paid for
it: the event log merged into Activity, and the map left the rotation for a
fixed share of the left column.

Where text still cannot wrap — a nameplate beside a health bar, an item line
with a value column, a card in a five-across strip that has to stay aligned —
`marquee.ts` scrolls it instead of cutting it. Only elements that actually
overflow move, at reading pace, so a page with nothing truncated carries no
animation at all.

### The readied ribbon

The one panel that shows the mechanic the whole scenario is built around.

A combat action is *readied*, not taken: five agents queue an intent without
seeing the others resolve, and the round settles at once when it closes. That is
what makes coordination measurable here rather than free. A viewer watching only
the aftermath prose sees the damage and never sees the commitment, which is
where the tension lives.

So the ribbon gives each class a lane, fills as intents arrive, and lights the
clash **before** the round resolves. `scene.clashes` comes from the same pure
`antiSynergies` the coordination diagnostic scores on, run over the intents
queued so far — and it is deliberately broadcast-only. The party can see who has
readied what; it cannot see this. The audience gets several seconds of knowing
the fireball is going into the group that was just put to sleep while the mage
still thinks it is a good idea.

The rogue's scouting report is shown for the same reason. It is private to the
rogue in the game — the party learns it only if the rogue says so — and the page
is a pure reader that cannot change the run, so showing the audience what one
agent knows while the others do not is free dramatic irony.

## Modules

Split so each is a pure renderer over one shared store, and so no two of them
touch the same file:

| file | owns |
|---|---|
| `viewer/broadcast/state.js` | polls all three endpoints, folds events into a scene, exposes it |
| `viewer/broadcast/stage.js` | the canvas: room, characters, enemies, attacks, damage numbers, speech bubbles |
| `viewer/broadcast/hud.js` | party bars, floor map, run progress, milestone ladder |
| `viewer/broadcast/feed.js` | Activity (speech and actions on one clock) and narration |
| `viewer/broadcast/names.js` | identifier expansion: `@mage`, `iron_sword@0004`, `beast-1`, `r3` |
| `viewer/broadcast/marquee.js` | scrolls a label that would otherwise be cut |
| `viewer/broadcast/records.js` | the scoreboard: best ever, today, this week, previous |
| `viewer/broadcast/ribbon.js` | the readied lanes, and the clash lit before the round resolves |
| `viewer/broadcast/director.js` | which panel is visible where, and when it changes |
| `viewer/broadcast/marks.js` | the drawn vocabulary: one shape per category, slot, status and event |
| `viewer/broadcast/happenings.js` | the pure scene diff: what moved, what was taken, what did nothing |
| `viewer/broadcast/index.html` | the shell and the layout |
| `viewer/broadcast/style.css` | tokens and layout |

`state.js` is the contract. Every other module receives a scene and returns
pixels; none of them fetch, and none of them import each other — the two
exceptions are `marks.js` and `happenings.js`, which are leaves that several
renderers share so that a sword looks the same in three panels and no two of
them disagree about whether the party moved.

### Categories, and the events nothing announces

Two problems went together. Every row of the account was the same grey
sentence, so finding out whether the party had moved, bought something or
levelled up meant reading all of it; and the things a viewer most wants marked
— a room entered, a retreat and the free swings it costs, a drop assigned, a
point spent — have no event anywhere in the trace. Both are answered from the
scenes themselves.

`marks.js` draws six silhouettes that cannot be confused at eleven pixels —
character, enemy, gear, consumable, room, effect — plus one per equipment slot,
status and event kind. **Shape carries the meaning and colour repeats it**, so a
re-encoded stream or a viewer who cannot separate the hues loses nothing.

`happenings.js` is a diff over two scenes: a tool call is an intention that the
round may close without, but a room id that changed is a room the party is
standing in. Movement, descent, retreat, loot assignment, equipping, levels and
talent ranks all come out of it, and the feed draws them differently from calls
for exactly that reason.

It also answers **why a blow did nothing**, which the arithmetic makes
answerable rather than guessable: physical damage is floored at 1 before shields
and a physical immunity comes back out of that floor as 1, so a physical zero
can only be a shield. For any other element there are two ways to reach zero, a
×0 resistance or a shield with enough left in it — and when both were available
the page says both. Naming one would be inventing state, and a viewer who
catches one invented label has a reason to distrust every other number on the
screen.

## Sprites

Drawn procedurally on canvas rather than shipped as images. Five classes and ten
enemy families plus four bosses is nineteen sprites, and a folder of PNGs is
nineteen things to keep in sync with a bestiary that is still being balanced.
Procedural also means a new family added to `content.ts` gets a silhouette from
its family name rather than a missing-image box.

What matters is **silhouette**: at broadcast size the reader has to tell a
guardian from a mage at a glance, and a crystal from a wisp, without reading a
label.

## Narration

The idea, in the user's words, is "a narrator who was an agent that strictly
observed and commented on the progress". Strictly observed is the load-bearing
half: it gets the trace and nothing else, and it can affect nothing.

```bash
pnpm run eval -- narrate               # follow the newest trace
pnpm run eval -- narrate --trace <f>   # or a specific one
```

It tails the trace, and at each round boundary sends the model a compact digest
of what changed — who acted, what landed, who is in trouble — and asks for one
or two sentences of commentary. Output goes to `<trace>.narration.ndjson`.

It is deliberately a separate command rather than a flag on `run`, so that
forgetting to disable it cannot contaminate a benchmark run.

### A silent narrator is the failure mode to design against

A dropped line is not fatal — a commentator who loses their line does not stop
the match — and that tolerance is what let three transport faults hide behind
each other until a run against NInfer on 2026-08-17 produced a narrator that
started cleanly, printed the sidecar path it was writing, and then said nothing
at all for the whole run.

| What was assumed | What NInfer does | Effect |
|---|---|---|
| an unknown key is ignored | `400 chat_template_option_not_supported` on `chat_template_kwargs` | every request refused, re-sent every 2s |
| 200 tokens is ample for a sentence | spends the budget on the thinking trace first | `finish_reason: "length"`, `content: ""` |
| the thinking channel is `reasoning` | calls it `reasoning_content` | the fallback for the above never fires |

The `??` in `content ?? reasoning` was a fourth: both local servers return `""`
rather than `null`, and `""` is not nullish, so the fallback was unreachable on
two counts at once.

Three rules came out of it, and they generalise past this one server:

- **Ask the server, don't assume it.** A capability is learned from the 400 that
  names it, once per run, and the request shape adapts. The budget is part of
  that shape: a server that will not stop thinking needs several times the
  tokens, because the trace comes out *before* the reply.
- **Silence needs a reason attached.** `onNote` exists so that a narrator which
  cannot reach its model does not look identical to a quiet dungeon.
- **A truncated thinking trace is worse than nothing.** With
  `finish_reason: "length"` what is in that channel is the model wondering what
  the question is — *"We need answer user's prompt?"* — and a viewer cannot tell
  that from commentary. The round is skipped instead.

### A commentator only knows what the digest hands it

Two failures in one run made the rule concrete, and they have the same shape.

An elite died in round 15 and neither round 15 nor round 16 mentioned it. A
defeated enemy simply stops appearing in `enemies`, and nothing said it had ever
been there — so the only evidence a kill happened was whatever the combat prose
chose to say, and that round it said nothing. Meanwhile three secret routes were
found across the run and not one was remarked on, because the digest read
`snapshot.scene` and every counter sat one field away.

So `digest()` now diffs the resolved snapshot round to round and states what
moved: `Killed this round: Elite Ash Hound.` and `Also this round: a hidden way
was found; a toll gate was paid open.` On the run this was built against, **22 of
40 rounds** carry a fact the commentator previously could not see.

The tell was already in the data: party deaths were narrated well *every time, in
every run* — and a party death is the one thing the digest already computed into
an explicit line.

The second failure is why there is now a separate instruction about cause. Handed
a toll payment with no reason attached, the narrator supplied one, reporting that
a character paid "trusting the rogue's scout report" on a round where the rogue
had not scouted at all. Every event in that sentence was real; the join between
them was invented. The blanket "never invent anything you were not told" did not
prevent it, because a commentator reaches for cause — cause is what makes a
sentence sound like commentary. The prompt now says it directly: report what they
did, never why.

## Developing against a bot

A real run is two hundred agent turns and about fifty minutes. Iterating on a
viewer against that is not iteration, it is one attempt an hour.

```bash
pnpm run eval -- rehearse --policy rule-based     # a full descent, in under a second
pnpm run eval -- watch --trace results/rehearsals/descent-rule-based.ndjson
```

`descent.sh --rehearse rule-based` is these two plus the bundle build, wired to
one path.

A rehearsal plays a baseline through the same public API the agents' tools wrap
and writes the same trace format, so every panel gets real data — beats, scenes,
milestones, a wipe at the end. It writes to `results/rehearsals/`, never
`results/traces/`, because the scoreboard scans the traces directory and a bot's
score sitting there as a record would be a lie about what any agent has done.

**A rehearsal plays the scenario's configuration by default**, which it did not
always do. The old defaults started on floor 31 with no maze, so `floorMap` was
null for the whole run and the floor graph, room movement, environments, locks
and gates drew nothing at all — and two separate pieces of viewer work were
verified against exactly that trace before anybody noticed.

The fix was the default, not a warning. The simulation declares what it is played
at and `rehearse` starts from that. To deviate deliberately:

```bash
pnpm run eval -- rehearse --policy rule-based --start-floor 31 --no-maze \
  --out results/rehearsals/descent-deep.ndjson
```

**A rehearsal takes `--sim-option` too**, which it did not until 2026-08-18 and
whose absence was silent in the same way the floor-31 default was: the flag was
accepted by `descent.sh`, forwarded to a command that had no such option, and
dropped, so a rehearsal played the *default* arm while its filename claimed
otherwise. It is now checked against the simulation's declared knobs exactly as
`run` and `bench` do, and an unknown one fails with a suggestion.

```bash
pnpm run eval -- rehearse --simulation descent-betrayed --policy investigator \
  --sim-option reveal=social --sim-option traitors=1 --rounds 30
```

`descent-betrayed` has its own baselines — `loyal-party`, `saboteur`,
`poisoner`, `investigator` — because it is a different game from `descent` and
its rungs measure different things. `investigator` is the one to rehearse the
social layer against: it reads, pools, buys a draught and executes on the
arithmetic, so it exercises every private panel on the page in a run that takes
under a second.

## Chat

The panel is real; the audience is not simulated. Showing invented viewer
messages would make a fabricated crowd look like a real one, so Activity carries
**what the agents are saying to each other** — which is the genuinely
interesting traffic — interleaved with what they did. A documented adapter seam
(`attachExternalChat`) accepts a real Twitch IRC feed when a channel is
configured; those lines land in the same column, tagged with their source and
set in neutral ink, so a stranger is never mistaken for one of the five.

## Comparing against past runs, without lying about it

The Records panel does not compare a run against every run on disk. It compares
it against its **cohort**: the runs that played the same game.

A run's fingerprint is scenario, horizon, start floor, whether the maze was on,
whether the party got a surface outfitter, and the whole remaining bag of
simulation options — `startingGold`, `startingSkillPoints`, anything added
later. The options are compared as a bag rather than as a hand-picked list of
names, so an option added next month splits cohorts the day it lands without
anybody remembering to update the comparison code.

**The seed is reported but is not part of the fingerprint.** A cohort spans
seeds on purpose — that is what makes it a measure of play rather than of luck —
and the panel says which seed is on screen and which it is being measured
against, so an easy draw cannot be read as an improvement.

Runs that do not match are excluded and the reason is named: *"7 set aside — 6 a
different starting floor; 1 a different startingGold"*. Runs whose configuration
cannot be established at all are labelled unverified rather than quietly
included.

That last case exists because, until 2026-08-14, **a trace recorded none of
this**. There was no seed and no options anywhere in the file, so a run started
on floor 31 with 900 gold was indistinguishable from one started on floor 1 with
180, and the scoreboard would happily crown the easier configuration. The `run`
event now carries `simulation: { name, seed, days, options }`, and where it is
present it is authoritative — the older inference (reading the start floor off a
snapshot, guessing the maze from whether a `floorMap` was ever published) is
skipped entirely rather than allowed to disagree with a declaration.

Rehearsals declare their configuration too, which is how `descent-oracle` at
floor 31 with no maze is finally *visibly* a different game from the scenario
rather than a silent mismatch.

## What it looks like, and why

**A surface station tracking an expedition that is underground.** An instrument,
not a game HUD: wet stone and iron, one sodium lamp, brass-and-verdigris for the
chrome that measures things.

That is a decision rather than a description, and it replaced a look that was
competent and completely anonymous — dark-slate cards at a uniform 10px radius,
`system-ui` throughout, an uppercase letter-spaced micro-label on every panel,
and a single orange accent on near-black. Every one of those is a default, and
together they are the house style of every dashboard generated in the last two
years. Three rules come out of the reading:

- **Panels are machined plates, not cards.** A 3px radius, a hairline border and
  a 1px inner top highlight, so they read as something bolted down. The
  highlight is the whole trick: without a lit top edge, a dark rectangle on a
  dark background is a card and reads as software.
- **The instrument speaks in monospace.** Labels, numbers and headings are mono
  with wide tracking and a cut tick in front of them; prose — the party channel,
  the commentary, the account of what happened — stays in the sans face, because
  that is people talking. A heading in the body face was quietly claiming to be
  something somebody said.
- **Two structural colours, not one.** Sodium lamp (`--flame`) for anything live
  or warm; verdigris (`--verdigris`) for frames, rules and tick marks, never for
  a reading. A lone warm accent on near-black is the cliché this is getting out
  of, and a second colour that is deliberately *not* used for data is what
  breaks it.

Status lights are square lamps set inside their lozenge rather than a coloured
bar down one edge — a thick accent border on the side of a box is the single
most recognisable tell of a generated interface.

### Which tokens the canvas also reads

`stage.ts` pulls `--ink`, `--dim`, `--faint`, `--flame`, `--panel` and
`--ground` at runtime through `readVar`, so re-pointing those in `style.css`
moves the stage with the page. The semantic colours (`--good`, `--warn`,
`--bad`, `--arcane`, `--gold`) and the five class colours are **duplicated by
value** in that file instead. Change one of those in CSS alone and the canvas
will quietly disagree with the panels about who is who.

## The floor map, and the two decisions it reversed

The map is the panel a viewer looks at most, and until 2026-08-16 it was drawn on
two assumptions that both turned out to make it unreadable.

**It only drew rooms the party knew about.** The original argument is worth
quoting because it is a good one: the broadcast was showing the audience the
floor's secret before the rogue had found it, "on a page whose whole claim is
that it shows the run". What it produced was a map whose *set of rooms* grew as
the party explored — and the layout is computed from that set, so every discovery
rearranged the floor.

**It rooted the layout at the party.** The breadth-first pass that decides which
row a room sits on started from `currentRoom`, so walking one room re-measured
every other room's depth and moved it.

Together those made a map that *transformed* rather than filled in. A viewer
cannot learn where anything is on a picture that redraws itself.

Both are reversed. The scene now carries the whole floor with `known` per room
and `discovered` per route, and the layout anchors at the **entrance**, which is
fixed for the life of a floor. The layout is a pure function of the floor:
discovery changes what is *shaded*, never where anything is. `floorplan.test.ts`
asserts it over two hundred floors, from both directions — the party standing in
every room in turn, and the floor fully explored, must not move a single room.

The framing that justifies it is the one that governs the traitor roster and the
rogue's scout report: **this page is viewer-facing, not player-facing.** It
reaches no agent, so showing the audience a room the party has not found costs
the run nothing and buys the thing worth watching — you get to see them walk past
it.

### What the map says now

Four states of knowledge, drawn as four different things rather than two:

| | |
|---|---|
| solid | visited |
| dashed arcane | scouted, not entered |
| dotted faint | a door leads there — unseen |
| dashed ghost | they have not found this (you can see it) |

Every room carries its **name**, not only a glyph. The entrance is `↑` and the
stairs down are `↓` — they were previously `IN` and an arrow, which made the two
rooms answering "where did we come in, where is the way on" look least like each
other. A room whose every known way in is still shut carries a badge for the
reason: locked, toll, or secret.

And there is a **legend**, built from the map's own CSS classes so an entry
cannot drift from the thing it explains, listing only what the current floor
actually contains.

### Two bugs worth remembering

**An SVG does not inset like a div.** Setting `left/right/top/bottom` and
`width: auto` on an `<svg>` resolves the width to 100% of the containing block
rather than to the box the insets describe, so the corridor layer kept full size
*and* moved — and with `overflow: visible` it drew a quarter of the way down the
page, through the legend and the panels below. Pad the **viewBox** instead and
leave the element at `inset: 0`.

**A percentage width resolves against the containing block, and an absolutely
positioned node is one.** Room labels were sized at a percentage of the map and
appended *inside* the room node, so 37% of the map became 37% of a 28-pixel
circle. Ten pixels. Every name rendered as two characters and a line break:
"silted guardroom" drew as "sil / te". The label is a sibling of the node now.

Both were invisible to every test in the package and obvious in one screenshot.
The lesson is not "add a screenshot test" — it is that the map draws in two
coordinate systems at once, HTML by percentage and SVG by viewBox, and each had
its **own copy of the arithmetic**. There is one copy now (`insetPercent`,
`insetViewBox`), and a test asserts the two agree for every room of two hundred
floors.

## The expedition panel

Audience-only, and hidden entirely on a run with no betrayal layer. It names who
is against the party, counts the murmurs, and scores every accusation right or
wrong. See [docs/endless-descent-betrayal.md](./endless-descent-betrayal.md) §B
for the two switches that control whether any of that is shown — one keeps the
answer out of the trace, the other only hides it on the page — and why they are
deliberately not the same switch.

The panel distinguishes three ways to have no names on screen, because they mean
opposite things: the seed rolled nobody, you asked not to be told, or the trace
does not carry it. Drawing all three as an empty cast would state the first,
confidently and often falsely.

## What this is not

- Not a replacement for `/`. The developer viewer stays exactly as it is.
- Not a control surface. There is no way to influence a run from the page, and
  adding one would change the benchmark into a different experiment.
- Not a video encoder. It is a web page; capturing it is somebody else's job.
