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
│            │                                    │                  │
│   MAP      │             STAGE                  │    NARRATOR      │
│   ⇅        │  (room, party, enemies, hits,      │                  │
│  EVENT LOG │   damage numbers, speech)          ├──────────────────┤
│   ⇅        │                                    │                  │
│  RECORDS   ├────────────────────────────────────┤   PARTY CHANNEL  │
│   ⇅        │   READIED THIS ROUND               │   (never cut     │
│  PROGRESS  │  (five lanes, clashes lit)         │    away from)    │
│            ├────────────────────────────────────┤                  │
│            │          PARTY HUD                 │                  │
│            │  (five bars, statuses, readied)    │                  │
└────────────┴────────────────────────────────────┴──────────────────┘
```

Only the **left** column rotates. The right column holds commentary above the
party channel and never cuts away from either — chat used to rotate against the
event log and the milestone ladder, and losing the party mid-argument to a
progress panel is the worst trade available: the negotiation *is* the show, and
the log largely restates prose the stage is already animating. The stage never
rotates away either.

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
| `viewer/broadcast/feed.js` | simplified event log, narration, chat |
| `viewer/broadcast/records.js` | the scoreboard: best ever, today, this week, previous |
| `viewer/broadcast/ribbon.js` | the readied lanes, and the clash lit before the round resolves |
| `viewer/broadcast/director.js` | which panel is visible where, and when it changes |
| `viewer/broadcast/index.html` | the shell and the layout |
| `viewer/broadcast/style.css` | tokens and layout |

`state.js` is the contract. Every other module receives a scene and returns
pixels; none of them fetch, and none of them import each other.

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

## Developing against a bot

A real run is two hundred agent turns and about fifty minutes. Iterating on a
viewer against that is not iteration, it is one attempt an hour.

```bash
pnpm run eval -- rehearse --policy rule-based     # a full descent, in under a second
pnpm run eval -- watch --trace results/rehearsals/descent-rule-based.ndjson
```

A rehearsal plays a baseline through the same public API the agents' tools wrap
and writes the same trace format, so every panel gets real data — beats, scenes,
milestones, a wipe at the end. It writes to `results/rehearsals/`, never
`results/traces/`, because the scoreboard scans the traces directory and a bot's
score sitting there as a record would be a lie about what any agent has done.

## Chat

The panel is real; the audience is not simulated. Showing invented viewer
messages would make a fabricated crowd look like a real one, so by default the
chat column carries **what the agents are saying to each other** — which is the
genuinely interesting traffic — and the narrator's line. A documented adapter
seam accepts a real Twitch IRC feed when a channel is configured.

## What this is not

- Not a replacement for `/`. The developer viewer stays exactly as it is.
- Not a control surface. There is no way to influence a run from the page, and
  adding one would change the benchmark into a different experiment.
- Not a video encoder. It is a web page; capturing it is somebody else's job.
