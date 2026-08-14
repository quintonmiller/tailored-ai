# The Endless Descent — review and proposed improvements

Written 2026-08-13, against the state of the tree at run 3. Companion to
[endless-descent.md](./endless-descent.md), which records why the scenario
exists and what it currently measures; this document is the forward-looking
half and supersedes that file's "Ways to improve" section.

## Status

| # | Proposal | State |
|---|---|---|
| 0 | Pacing: health tracking party damage, dread not charged in combat, reinforcements capped, bosses resolvable | **shipped** |
| 1.1 | The readied ribbon | **shipped** |
| 1.2 | Party channel out of the rotation | **shipped** |
| 1.3 | Dread and the record to beat permanently in the header | **shipped** |
| 3.1 | Attunement cap (plus `unequip`, which it needs) | **shipped** |
| 3.2 | Caches replacing the merchant as the common find | **shipped** |
| 3.3 | Scout-ahead — made *private*, so it has to be relayed | **shipped** |
| 1.4 | Learned-mechanics board | not started |
| 1.5–1.7 | Moment framing, repetition collapse, contribution bar | not started |
| 2 | Theme direction | **waiting on a decision** — three rendered directions, see §2 |
| 3.4 | Zones | not started |
| 3.5 | Asymmetric paths, commitment costs | partial — paths now have bands, values still symmetric |
| 9 | Full party splitting | not started, deliberately |

What the shipped set measured, over 24 seeds at forty rounds from floor 31:

| | before | after |
|---|---|---|
| floors cleared by `rule-based` | 1 | ~5 |
| bosses defeated, *any* policy | 0.0 | 1.0 for competent rungs |
| ladder spread | 5,865 | 5,341 |
| `rule-based` earned | 10,230¹ | 9,317 |

¹ The before-figure is inflated: with combat eating the run, the policy never
spent a round on anything else. The comparison that matters is the boss row and
the floor count.

Three areas were asked about — how clearly events reach a viewer, how the page
looks, and how the game plays. A fourth thing turned up while measuring the
first three, and it comes first because it is upstream of all of them.

---

## 0. The finding that reorders everything: the run is one long fight

Run 3 was measured live at tick 24. The phase histogram:

| phase | ticks |
|---|---|
| combat | 19 |
| explore | 2 |
| market | 2 |
| spoils | 1 |

In twenty-four rounds the party descended **one floor**, fought one encounter
to completion (13 rounds), and was six rounds into a second. The horizon is 40
rounds.

It then ran to the horizon and confirmed the projection exactly:

```
floorsCleared 1     enemiesDefeated 11    bossesDefeated 0
earnedXp 4,731 (wanted ≥6,000)           survivors 1 of 5
score 37/100 — failed
```

Forty rounds, **one floor, eleven enemies**. The scenario's own milestone list
says the rest better than any commentary could — every unreached milestone is
one that requires either descending or having time outside a fight:

| | milestone |
|---|---|
| ✗ | scouted-before-committing |
| ✗ | moved-an-item-to-somebody-who-can-use-it |
| ✗ | pooled-a-purse |
| ✗ | bought-something-nobody-could-afford-alone |
| ✗ | went-three-floors-down |
| ✗ | went-six-floors-down |
| ✗ | put-down-a-boss |

Everything the party *was* given time to attempt, it passed: it took stock,
read enemies, fought, cleared a floor, beat a thoughtless party, left nobody
behind, and did not fall for the same trick twice. **The scenario is failing the
party for not doing things the pacing never let them reach.** The next boss from
floor 31 is on floor 35; at one floor per forty rounds it was never reachable.

The arithmetic behind it:

- Party damage output, measured across 19 combat rounds: mean **423/round**,
  range 198–696.
- Enemy health on stage at tick 23: **4,253** total across five bodies, of
  which 2,649 was still standing.
- Time to clear one ordinary encounter: **~10 rounds**, before reinforcements.

That is a time-to-kill of ten rounds against a budget of forty.

It gets worse than slow, because it compounds. `advance()` adds a point of dread
on every combat round where enemies remain (`index.ts:1252`), and
`generateEncounter` converts dread into extra bodies at
`reinforcements = floor(dread / 4)` (`content.ts:404`). A fight that drags
raises dread; the raised dread makes the *next* encounter larger; a larger
encounter drags longer. At tick 18 the party walked out of a 13-round fight
with dread at 13 and straight into a six-enemy encounter. There is no negative
feedback anywhere in that loop.

**Why this is upstream of everything else asked about:**

- *Viewer clarity* — the narrator produced three consecutive rounds of near
  identical commentary (R20, R21, R22 all reduce to "the Rogue is still down and
  the Warden is still being chipped"). No presentation fix survives content that
  repeats.
- *Gameplay* — path choice, the market, loot allocation and descent decisions
  are 5 of 24 rounds. The interesting multi-agent surface is almost never
  reached. Every new mechanic proposed below would inherit the same starvation.
- *Measurement* — the allocation, pooling and conservation diagnostics are thin
  for exactly this reason. They are not weak instruments; they are barely given
  anything to read.

**Proposed fix, in order of confidence:**

1. **Set a time-to-kill target and scale to it.** For a 40-round run to cover
   six to eight floors, an ordinary encounter has to resolve in 3–4 rounds and a
   boss in 6–8. That means total encounter health near 3–4× party per-round
   damage, not 10×. The cleanest lever is enemy count and per-enemy health,
   which `depthScale` already centralises — the HP exponent (1.07/floor)
   outruns the party's damage growth, and that gap is the whole defect.
2. **Stop dread compounding inside the fight it caused.** Dread is meant to
   punish *lingering* — deliberating in `explore` and `spoils`. Charging it
   during combat punishes the party for being in a fight that is long because
   the numbers made it long. Either freeze dread during combat, or decay it on
   encounter clear.
3. **Cap reinforcements per encounter** at +1 regardless of dread, so the spiral
   has a ceiling even if the first two are mistuned.
4. **Re-run the baseline ladder after each change.** This is a `bench` sweep —
   seconds, no model cost — and it is the only reason the earlier balance
   defects were caught cheaply.

This should land before anything below it. Everything else is more interesting;
this is the one that decides whether the rest gets exercised.

---

## 1. Communicating events to the viewer

The page already does the hard parts well: the stage draws real sprites, the
beats animate, the party cards carry health/mana/status/readied action, and the
combat prose is genuinely good. The gaps are about *legibility of causation*
rather than missing data.

### 1.1 Show the commit, then the resolve — the "readied ribbon"

**This is the highest-value change on the page.**

The core drama of the game is structural and currently invisible: five agents
queue an intent blind to each other, and then the whole round resolves at once.
That is what makes a fireball into a sleeping enemy possible, and it is the one
thing this simulation does that an ordinary RPG does not.

Right now a viewer sees the aftermath prose. They never see the moment where
five commitments are on the table and nobody knows yet whether they fit.

Proposal: a horizontal ribbon under the stage that fills as intents queue —
five slots, each showing actor → action → target as it is readied — and then
plays the resolution across it. Anti-synergies are already detected
(`antiSynergies()` in `model.ts` returns six detectable pairs) and are currently
only counted in a diagnostic; surface them here as a visible clash between two
slots. When the round resolves, the ribbon shows which intents landed, which
were wasted, and which collided.

That single component makes coordination — the thing the benchmark exists to
measure — watchable.

### 1.2 Chat should not be rotated against the log

The right column rotates chat → log → progress every 14s. Chat is the show;
the party negotiation sampled from run 3 is the most compelling content on the
page by a wide margin:

> **guardian:** I'm attacking crystal-5 this round. Rogue is down — @cleric can
> you heal or revive them? @mage @ranger — focus the remaining enemies.

Cutting away from that mid-argument to show a progress panel is the wrong
trade. Proposal: chat gets a permanent home; the rotation carries log, progress
and records. If space is tight, the log is the panel to rotate — it largely
restates prose the stage is already animating.

### 1.3 Tension instruments belong in the header, permanently

Dread lives in the map panel, which rotates away. Dread is the pressure clock —
it decides ambushes and reinforcement counts — and it is invisible for two
thirds of the time. Same for "round X of 40" and the record to beat.

Proposal: a permanent instrument strip — floor, round of horizon, dread, party
standing, and *the score to beat* — always on screen. A viewer with no idea what
they are watching should be able to read stakes off the top of the page.

### 1.4 A learned-mechanics board

Hidden mechanics are the memory dimension, and they are the hardest thing in
this benchmark to see. A viewer watching the mage take reflected lightning has
no way to know that the reflection is a fixed, learnable property of that
family — or whether the party has learned it.

Proposal: a small standing board — "what the party knows" — that fills in as
mechanics fire: *crystal — reflects lightning (learned f32)*. Then, when the
party walks into a crystal warden ten floors later and casts lightning anyway,
that failure is legible instead of invisible. `diagnostics.ts` already tracks
first-fire per family, so the data exists.

This is the change that best answers "what is this benchmark actually testing"
for someone who has just arrived.

### 1.5 Give the big moments a beat

A member going down, a boss appearing, a level, a wipe. These currently pass as
one more line. Proposal: a brief full-stage treatment — 1.5–2s, the director
already has claim/dwell machinery for exactly this — then back. Restraint
matters; if everything is a moment, nothing is.

### 1.6 Collapse repetition honestly

The log already collapses consecutive identical lines into `×n`. Extend the
same idea upward: when several rounds reduce to the same shape, say so — *rounds
8–12: trading blows, no change* — rather than printing five near-identical
entries. If §0 lands this matters less, but a long boss fight will always
produce some of it.

### 1.7 Round contribution

A small per-round bar showing who dealt and absorbed what. Cheap, and it answers
the question a spectator asks constantly: *who is actually carrying this?*

---

## 2. Theming

The instinct that it reads generic is correct, and the reasons are specific
rather than a matter of taste.

### What is making it read as default

| Tell | Where |
|---|---|
| `system-ui` as the display face | `style.css:45`, and again hardcoded in `stage.ts:76` for canvas |
| 10px uppercase letter-spaced eyebrow on every panel | `.panel > h2` |
| Uniform 10px radius cards with 1px hairline borders | `--radius`, `.panel` |
| Three-column dashboard grid | `main` |
| Near-black ground + exactly one warm accent | `--ground` / `--flame` |
| Flat radial gradient as the only texture | `#stage` |

Every one of those is a defensible engineering choice, and together they are
the house style of an internal admin tool. Nothing in the palette or the type
says *underground*, *doomed*, or *expedition* — the theme is carried entirely
by the words and the sprites, and the chrome around them is neutral.

The palette is also depth-blind: floor 31 and floor 45 look identical, which
throws away the most natural source of visual progression the game has.

### Fixes that apply under any direction

1. **A real display face, inlined.** The page is served by our own watch server,
   so a woff2 can ship next to the CSS — no CDN, no CSP problem, no silent
   fallback. Pair it with a proper mono for figures. `stage.ts` must read the
   same stacks rather than repeating literals.
2. **Retire the uppercase eyebrow on every panel.** Let panels be identified by
   their content and their frame; keep the label where a panel is genuinely
   ambiguous.
3. **Vary the frame.** Uniform radius on every box is what makes it read as a
   component library. The stage is the subject and should be framed differently
   from the instruments around it.
4. **Texture on the ground.** Grain, vignette, and a slow torch flicker tied to
   the existing `--flame`. Cheap, and it converts "dark UI" into "lit room".
5. **Let depth drive the palette.** Shift the ground and accent every few
   floors. It is thematic *and* informational — a returning viewer can tell how
   deep the party is from across a room.

### Three directions

Deliberately none of these is the warm-cream-serif, the acid-pop-on-black, or
the gradient hero. Each is a different answer to "what kind of object is this
page".

**A. Survey station.** The premise: we are monitoring something we cannot
reach. Cold slate and instrument cyan, hairline grids, figures in a real mono
with tabular numerals, panels as instrument faces rather than cards. The stage
reads as a feed being received. Restrained; ages well; closest to the current
information density, so the cheapest to reach.

*Palette:* `#070b0f` ground, `#0e161d` panel, `#3fd0c9` signal, `#c8582f`
alarm, `#93a7b4` dim.
*Type:* a condensed grotesque for display, a proper mono for data.

**B. Reliquary.** The premise: the descent as a religious record being
illuminated as it happens. Deep oxblood ground, gold leaf, panels as carved
niches with real drop caps, rules that look struck rather than drawn. Maximal
and memorable; the highest ceiling and the highest execution cost, because
half-done ornament looks worse than none.

*Palette:* `#140a0c` ground, `#1e1013` panel, `#c9a227` leaf, `#7c1f2b` blood,
`#a08f83` dim.
*Type:* a high-contrast serif with real texture for display; a humanist sans for
body.

**C. Broadcast desk.** The premise: lean all the way into Twitch Plays. Heavy
condensed type, class colours as team colours, a persistent scoreboard bug, and
lower-thirds when someone speaks. Most legible at a glance and most obviously
*a show*; the risk is that it fights the subject matter — a sports desk over a
death march can read as a joke unless it commits to being one.

*Palette:* `#0b0b0d` ground, `#16171b` panel, per-class team colours as the
accent system, one hot signal for records.

My recommendation is **A** if the goal is something that stays watchable for an
hour, **B** if the goal is something people screenshot. Both are large enough
that the direction should be settled before the work starts.

---

## 3. Gameplay

The framing I would apply to every candidate: *does it create a decision that
one agent cannot make alone?* That is the axis this benchmark measures and the
axis an ordinary roguelike does not.

### 3.1 Items — depth beats count

More items were asked for, and more items is right, but count alone does not
produce the roguelike property being described. What makes item decisions matter
is **foreclosure**: taking this means not taking that, and the choice is
argued about. A catalogue of eighty items that are all "+7 power, strictly
better than the last one" is a bigger table with the same single decision in it.

Five structural changes, each of which turns an item into a conversation:

1. **Attunement cap.** The party may have only N trinkets attuned at once. A
   sixth trinket is not a gain, it is a proposal to unattune someone else's.
   Highest value per line of code in this section — it converts every trinket
   drop into a party negotiation, and it needs one counter and one check.
2. **Unidentified items.** Drops arrive unknown. Using one is a gamble; a
   merchant will identify for gold. This gives risk appetite something to
   attach to, and gives the merchant a job other than vending.
3. **Shared charges.** A wand with three charges, held by one member, usable by
   the party. One object, several claimants, and a conservation decision that
   has to be spoken aloud.
4. **Resonance pairs.** Two items that only do anything while held by *different*
   members. Cannot be resolved without a trade.
5. **Real drawbacks.** +power / −max health, +speed / −armour. A strict upgrade
   is not a decision; a trade is.

Then expand the catalogue — the current 28 to something like 70–80 across the
existing kinds — with the structure above applied, so the added count multiplies
decisions rather than diluting them. Class restriction plus random assignment
already does good work here and should stay.

### 3.2 The market — the realism question, answered

The honest answer: **as written, it does not make sense.** A merchant "sets up"
on floor 32 of an endless lethal dungeon, restocks every third floor, and
accepts gold. Nothing explains who they are, how they got below the party, or
what gold buys this far down.

It is also mechanically weaker than it looks, and run 3 measured exactly how
weak. The party reached a market once, in the opening two rounds, and engaged
with it enthusiastically:

```
goldSpent 5,309      goldRemaining 11,944
pooledPurchases 0    goldTransfers 0    tradesMade 0    diagPooling 0
```

Every coin of that 5,309 was spent privately, out of one purse, by one agent, on
themselves. The pooling diagnostic — the only one of the seven that read **0** —
had nothing to measure, and the party finished sitting on **twelve thousand
unspent gold** because no second market ever arrived. A shop that appears once
per run and can be used unilaterally is not an economy; it is a vending machine
that happened to be on the way in.

Three replacements, best first:

1. **The cache — recommended.** Previous expeditions died here; their packs are
   still on them. The party finds six items and may take **two**. This is
   strictly better than a shop for this benchmark: it explains itself
   diegetically, explains why gear gets better as you descend (they got
   further), and — crucially — replaces a private purchase with a hard
   collective cap that *must* be argued about. It is the single strongest
   multi-agent decision available cheaply.
2. **The scavenger.** If trade is worth keeping, make the trader a resident:
   something that follows a descent because it eats what dies, and trades
   because it wants something the party carries. It is ahead of you because it
   follows the noise. Barter rather than gold — it wants a corpse, a relic, a
   name — which is a more interesting economy than a price list, and gold keeps
   its meaning at a shallower vendor.
3. **Keep the shop, explain it.** Cheapest. A faction that mines the upper
   floors and profits from descenders; merchant marks cut beside stairs (already
   in the path labels) become their trail. Weakest of the three, because it
   leaves the private-purchase problem untouched.

Recommendation: caches as the common case, a scavenger as a rarer and stranger
encounter, and gold retained so pooling still has something to do.

### 3.3 Splitting the party — take the cheap 80% first

Full splitting is expensive and it was named as such: two combat states, two
enemy sets, addressing agents to sub-parties, rejoin rules, and the ugly case
where one group wipes while the other is mid-fight. That is a large change to
the resolver and to every diagnostic that assumes one party.

Most of the *communication* value can be had for a fraction of it:

**Scout ahead.** One member goes forward alone and rejoins next round. They come
back with private information — what is down there, how many, what it is
carrying — that the rest of the party does not have and must be *told*. It
costs that member's action, and it carries personal risk.

That delivers the three things splitting is wanted for:

- genuine information asymmetry, with a speaking requirement attached
- a real risk-allocation argument (the rogue scouts best and is also your
  damage)
- a decision about whether the information was worth the round

and it needs one new action plus a private-result path, both of which already
exist in shape (`inspect_enemy` already returns per-class private slices).

I would build this first and treat full splitting as a later phase with its cost
stated plainly, rather than as the next step.

### 3.4 Zones — the cheapest realism win

Floors currently differ only by number: same four path archetypes shuffled
(`content.ts:739`), same families, arithmetic scaling. Nothing marks floor 34 as
a *place*.

Proposal: bands of floors with character — a flooded level, a library, a
mustering ground, a hatchery — each carrying a modifier that changes play (fire
halved in the flood; sound carries in the library so dread rises faster;
reinforcements arrive faster in the mustering ground). This hits all three of
the areas asked about at once:

- **gameplay** — the party has to adapt a working strategy to a changed rule,
  which is a genuine planning problem rather than a bigger number
- **realism** — the dungeon becomes a built thing with a purpose
- **the page** — the stage gets a different backdrop and palette per zone,
  which is the depth-driven palette from §2 with a reason behind it

### 3.5 Decisions that require argument

Two smaller additions in the same spirit:

- **Asymmetric paths.** Make the four ways on carry class-asymmetric value — one
  is good for the mage, one for the rogue. The party then has to trade off whose
  turn it is to benefit, which is a negotiation rather than a lookup. Today all
  four paths are the same four archetypes shuffled, so the choice is nearly
  free.
- **Commitment costs.** Descending closes the floor. Anything left behind is
  left behind. Making that explicit and irreversible gives "should we push on or
  clear this floor" real weight.

---

## Suggested order

| # | Work | Why here | Cost |
|---|---|---|---|
| 1 | Pacing: TTK target, dread not compounding in combat, reinforcement cap | Everything else is starved until this lands | small |
| 2 | Readied ribbon + permanent chat + header instruments | Makes the existing game legible; no simulation risk | medium |
| 3 | Caches replacing shops; attunement cap | Two changes, both converting private decisions into party ones | small |
| 4 | Theme direction, chosen then executed | Large enough to want a decision first | medium–large |
| 5 | Scout-ahead | The splitting value, at a fraction of the cost | small |
| 6 | Item catalogue expansion with the structural rules from §3.1 | Depends on 3 for its shape | medium |
| 7 | Zones | Best combined payoff, but wants pacing and theme settled first | medium |
| 8 | Learned-mechanics board | Wants zones and a longer run to be worth reading | small |
| 9 | Full party splitting | Real cost, real complexity; deliberately last | large |

Items 1 and 3 are the ones I would do regardless of any other decision. Item 4
needs a direction chosen before work starts.

## What this does not address

- **Run length.** Everything here assumes the 40-round horizon. If §0 lands, 40
  rounds becomes six to eight floors, which is enough for most of the above. The
  memory dimension still wants a longer run to be measured properly, and that
  remains the open question recorded in
  [endless-descent.md](./endless-descent.md).

  Run 3 shows how far from measured it currently is: `diagMemory` reported
  **100** off `memoryOpportunities: 1`. A perfect score from a single sample is
  not a reading, and the same is true of the allocation (100) and conservation
  (100) figures. Four of the seven diagnostics are currently reporting near
  ceiling because they are barely being asked anything — which is a starvation
  symptom, not a competent party. Treat every diagnostic above 95 with an
  opportunity count in single digits as unmeasured.
- **Whether the model can use any of this.** Every mechanic added is a mechanic
  a 27B model has to hold in context alongside the rest. The item catalogue in
  particular should be checked against tool-schema pressure before it triples.
