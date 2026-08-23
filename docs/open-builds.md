# Open builds — a scenario with a brief instead of a score

**Built, green, and run against a live model three times.** Three scenarios, a
`workshop` simulation, a `review:` schema flag, a scripted rehearsal, a real
headless-browser `playtest`, a game-jam layer with themes and a scorecard, and
61 tests. Five faults have been found by running it, each of which would have
been invisible from a trace. The remaining phases at the bottom are still a
plan.

## The idea

Five agents, three channels, a brief, and twenty rounds. At the end there is no
number. There is a directory with something in it, a transcript of how it got
there, and a person who opens it and forms an opinion.

This is the endless descent with the dungeon replaced by a workspace and the
score replaced by a reviewer. Every other scenario in this package answers a
question the package itself can settle. This one asks the question the package
cannot answer and that nothing else here is even shaped to ask — *is what they
made any good* — and hands it to the only instrument that can.

It is worth having for three reasons that have nothing to do with scoring.

**The artifact outlives the run.** A descent run leaves a number and a trace. A
build run leaves a thing you can open. That changes what a bad run tells you:
"scored 2,883" is a fact about a benchmark, and "the movement code is fine and
nobody ever wrote a collision check" is a fact about the framework.

**It runs long enough to break the memory story.** 220 turns, and the history
budget will trim the conversation that agreed the plan. Whether the team stays
coherent past that is currently unmeasurable — the descent's memory diagnostic
gets "roughly one opportunity per run". Here the workspace *is* the memory, and
a team that forgets what it agreed in round four contradicts itself in a file
you can read.

**There is no answer to re-author.** `the-lock` cost a session to write and was
solved on its third run. A brief cannot be beaten; it can only be executed
better.

## Running it

```bash
# no model, seconds: a bot builds something and writes a trace
npx tsx scripts/workshop-rehearse.ts --brief=arcade
npx tsx src/cli.ts watch --trace results/rehearsals/workshop.ndjson

# the real thing, ~2 hours a run against a local model
pnpm run eval -- run --filter the-workshop --max-scenario-minutes 240
pnpm run eval -- run --filter the-workshop --sim-option brief=site
pnpm run eval -- run --filter the-workshop-in-one-room   # control arm
pnpm run eval -- run --filter the-workshop-alone         # solo control arm
```

The artifact lands in `packages/evals/results/workshops/<brief>-<seed>-<stamp>/`:
`brief.md`, `workspace/` (open `index.html`), `rounds/NNN/` (a frame per round
in which something changed), and `manifest.json` (every edit, who made it, and
what the final check said).

## Three channels, not one room

The descent puts all five agents in one room on purpose, and says why: its
sibling scenarios already measure what happens when a fact must cross a wall, so
splitting the party too would make a low score ambiguous between "could not play
the dungeon" and "could not get a number across a room".

That argument does not apply to a row with no score to be ambiguous about, and
the reason to split here is different and specific. One room means every message
costs every agent context, and over 220 turns the transcript is the single
largest consumer of the history budget — a team that talks in one place trims
away its own plan.

| channel | who | for |
|---|---|---|
| `studio` | all five | decisions, blockers, anything everyone needs |
| `build` | lead, builder, tester | implementation and defects |
| `craft` | lead, interface, author | what it looks like and what is in it |

The **lead is the only agent in all three**, which makes it the bridge, and — as
`the-machine-across-a-divide` established — nothing tells it that being the
bridge is a job.

The crossing that matters here is not a token. `engine.js` belongs to the
builder and `render.js` belongs to the interface; the second reads state the
first defines, and those two agents share no channel but the all-hands. If they
do not agree on the shape of that state, the artifact opens to a blank canvas
and every syntax check passes on the way there.

`wakeSteps` already interleaves round-major across rooms, so this needed no
harness work. Eleven turns a round: the lead three, everybody else two.

### The lead gets one mind, everybody else gets one per room

Room sessions are per-`(room, agent)` by default, which is right — what an agent
does in one place should not leak into another. Applied to the bridge it is
wrong in a way that would sink the run: the lead would arrive in `craft` with no
memory of what it agreed in `build` ninety seconds earlier, and the one agent
whose entire job is carrying decisions between channels would be the one agent
unable to. So the lead alone gets `roomSessionScope: "shared"`.

Core's own note on that setting says continuity of *work* is better served by
durable state than by a shared session, and that is true — `design.md` is
exactly that durable state and the lead owns it. This is the other half:
continuity of *conversation*, which is what a bridge is made of. The cost is a
session that grows with three rooms rather than one, and the lead is therefore
the agent most likely to hit the history budget. Worth watching in the first run.

## What "no score" means, mechanically

`review: true` on a scenario. It has three consequences, and the third is the
one that matters:

- `expect` becomes optional, and the round cap relaxes from 40 to 400.
- `report.ts:score()` skips the row entirely — it contributes `0/0`, the same
  way an errored one does, and `--min-score` cannot be moved by it. The summary
  prints `REVIEW` rather than `PASS`, because a run with no checks satisfies
  `every()` vacuously and printing PASS next to an artifact nobody has opened is
  a lie in the report's most-read line.
- The scenario is **forbidden** from carrying `expect` or `milestones` at all.

That last rule is not tidiness. A review simulation still has to implement
`metrics()`, metrics are numbers, and a number in a report gets ranked by the
next person who reads it. The first person who wants a red/green row will reach
for `sim_metric: { metric: "linesWritten", at_least: 400 }`, and that assertion
would be measuring typing. Making it a load error is the only version of this
rule that survives contact with a Friday afternoon.

The counters the simulation does report are printed under a heading that says
*activity, not achievement*. The two worth reading first are `patchesRefused`,
which climbs when the team's model of a file has drifted from the file, and
`roundsWithNoWrite`, which climbs when they are talking instead of building.

## The five decisions

### 1. The world is a real directory, reached through simulation tools

The obvious approach is to un-stub core's `write`, `read`, `edit` and `exec`.
It is wrong: `STUBBED` exists to catch *anything that reaches outside this
process*, and loosening it changes every scenario's blast radius. Simulation
tools are already exempt by contract, because they have a real implementation
and it is the thing under test.

Two consequences that had to be designed around rather than discovered:

**Names must not collide with core's.** On 2026-08-18 the descent's `read`
collided with core's file-reading `read`, a model called it in round three, and
the call was answered with *"(stubbed in the benchmark…)"* while the metric it
fed stayed at zero. Hence `read_file`, `write_file`, `patch_file`,
`check_syntax`.

**The workspace cannot live in `TAI_HOME`.** `runOnce` builds it with
`mkdtempSync` and `rmSync`s it in a `finally`, so an artifact written there is
deleted at the moment somebody wants to look at it.

`write_file`, `patch_file` and `delete_file` are `agentTool`s in `sharedTools()`
rather than per-role tools, because `simulationGrants` registers by *name*: two
roles exporting a `write_file` would both get whichever was built last.

### 2. The deliverable is a folder with no build step

The plan originally said one self-contained HTML file. That contradicts a
per-role file partition, so the trade is made the other way: give up "one file",
keep "no build". The brief asks for a folder you open `index.html` from, with
classic `<script src>` tags in a load order the interface owns.

The `arcade` brief is one of three, and the brief is a `--sim-option` rather
than a scenario — `arcade`, `tool` (a utility with real edge cases) and `site`
(a documentation site for a tool that does not exist). The third is deliberately
not a game, to check that the machinery is not secretly a game framework.

Prefer briefs with an unusual constraint. A model that has read a thousand
breakout clones will produce a competent breakout clone, and the polish is
memorised rather than earned.

### 3. No code execution

`check_syntax` parses and never runs: `node:vm`'s `Script` compiles without
executing, JSON goes through `JSON.parse`, CSS is brace-balanced, and HTML gets
tag balance plus script extraction plus a check that every `<script src>` and
`<link href>` points at a file that exists. No subprocess, no timeout to tune,
no sandbox, and no new dependency — deliberately not esbuild, which is a
devDependency and would give a private package a runtime it did not declare.

A test asserts the checker does not execute what it parses. If it ever fails,
`check_syntax` has become an execution engine and this section is wrong.

The cost is real and is stated in the brief: **nobody can tell whether it
works.** A syntactically perfect page that throws on load passes everything. The
tool says so in the same breath as reporting success, because "checks passed"
reads as "it works" unless something says otherwise.

Phase 4 is a containerised headless playtest. It is the biggest quality lever
available and it is a week of work.

### 4. Editing is surgical, or the run dies of context

Arithmetic, not taste. A whole-file write of a 900-line file costs it twice
over, and a descent run reached 44,913 tokens against a 32,768-token server and
died at round 13.

| tool | why |
|---|---|
| `patch_file` | the primary editing tool: one exact occurrence, refuses on zero or on two |
| `read_file` | numbered slice, 120 lines by default and 240 with a range |
| `outline_file` | headings and top-level definitions with line numbers |
| `write_file` | whole file, correct for creating one |
| `list_files` | tree with line counts, owners, and what the brief expects to exist |

`list_files` shows the planned layout from round zero with `(not created yet)`
beside each row. Five agents who each invent a filename in round one produce
five near-duplicate files nobody agreed on.

### 5. Write access is partitioned; read access is not

Difficulty in a multi-agent scenario comes from the shape of the team — 98/98
against 32/52/107 on the same model. But a build task punishes artificial
asymmetry, because hiding the code from the person writing it makes the artifact
worse and the artifact is the deliverable.

| role | writes | uniquely |
|---|---|---|
| `lead` | `design.md` | in all three channels; writes no code |
| `builder` | `engine.js` | state, rules, everything that happens |
| `interface` | the page, `render.js`, `style.css` | decides script load order |
| `author` | `content.js` | data, tuning, copy — no behaviour |
| `tester` | `defects.md` | the **only** role that can call `check_syntax` |

Everybody reads everything. The tester holding `check_syntax` alone is the one
deliberately artificial constraint and the most interesting: it makes "has
anybody checked this" a question the team has to notice it should be asking.

Both are knobs — `--sim-option ownership=shared`, `--sim-option checks=anyone`.

## The control arms, at turn parity

`the-workshop-in-one-room` is the same brief with everybody in `studio`.
`the-workshop-alone` is one agent holding every tool. Both get **220 turns**,
the same as the split arm, because the question is "given the same budget, does
the shape of the team help" and not "does more model time help". Round parity
would have answered the second while appearing to answer the first.

The solo arm is the uncomfortable one and is the reason to build it: it is the
only row in this package that could say whether five agents beat one at a task
with an artifact at the end. Read it on the artifact, not on the counters — a
solo agent wins `linesWritten` almost by construction, because it never spends a
turn agreeing with anybody.

## Three harness bugs this found before any model ran

The descent's most valuable trick is a scripted policy that plays the game
before a single model call. Six scripted parties found four balance defects that
would each have been misread as an agent failure. The same trick here found
three faults, none of which would have been red:

**`buildConfig` looked a role up by agent name.** `simulation.roles` is written
role-first, and every scenario so far names its agents after its roles — so
indexing it *by agent* returned the right answer by coincidence.
`the-workshop-alone` maps five roles onto one agent called `maker`, where the
lookup returned undefined and the arm ran **with no brief at all**. The one arm
that most needed the task description was the one that would not have got it.

**`buildConfig` mutated the scenario's own agent block.** `deepMerge` copies an
absent key by reference, so a build wrote through to the loaded scenario.
Rebuilding a tool set from a superset is idempotent and hid this; appending a
brief is not, so `--repeats 3` would have accumulated the brief three times.

**The path rule was enforced on one entry point of six.** `normalisePath`
guarded `plan()`, and `write`/`read`/`patch`/`remove`/`slice`/`outline` were
trusted. The extension rule was therefore being checked against the brief's own
layout and against nothing a model ever typed.

Two smaller ones: `announce()` said "round 17 of 16" past the horizon, and
`finishSimulationTrace` ran the world on unattended for every simulation —
correct for the factory, where an abandoned company keeps paying wages, and
meaningless for a workshop nobody is typing in. `runsOnUnattended` now gates it,
matching the descent's own need for the same switch.

## What the first live run found (2026-08-20)

Run against **Qwen3.8-27B NVFP4 on NInfer**, `medium` effort, 131,072-token
context, MTP speculative decoding, `openai` thinking dialect (NInfer takes
`reasoning_effort` as a top-level field and rejects the `vllm_effort` dialect's
`chat_template_kwargs`). A three-round smoke of 33 turns cost 425 seconds —
**12.9 s/turn** — though a tester turn that reads six files runs nearer 45 s, so
budget a twenty-round run at two to three hours rather than one.

### Three faults, none of which would have shown up as red

All three shared a shape worth naming: **core validates a tool's schema before
`execute` runs, and a rejection there happens inside the loop rather than in the
tool — so no `call` event reaches the trace at all.** The instrument reads as
unused and the counter it feeds stays zero, which is indistinguishable from a
team that never tried.

- **A schema that refused the correct argument.** Simulation parameters were all
  declared `type: "string"`, because `num()` exists to cope with models that
  pass strings for everything. That told the validator to reject the *number*
  form. Now a `["string", "number"]` union, which widens what is accepted and
  narrows nothing.
- **Every parameter marked required.** `tool()` requires everything it declares,
  which is right for an instrument where all the arguments matter and wrong for
  `read_file`, whose `from`/`to` are an optional window. Saying "Optional" in the
  description and `required` in the schema is worse than either alone. This was
  the builder's *first* action in the first run: `read_file({path})`.
- **The last round was never counted.** `runRoomScenario` advances the clock
  between rounds, so an N-round run crosses N-1 boundaries and a simulation
  whose only ending is its horizon never arrives. The smoke announced rounds 0,
  1 and 2, took all 33 of its turns, and reported `roundsPlayed 2` with an `end`
  event carrying no reason at all. The descent hides this because its runs
  usually end in a wipe, which sets `done` from inside. Fixed with `finish?()`
  on the seam — a simulation is never told how long the roster is, and
  `runsOnUnattended` answers a different question.

### What the run itself did

Seven files, 613 lines, five distinct writers, `check_syntax` clean, **zero
ownership refusals** across 139 calls. The team invented a game — a flame in a
dark room whose light radius *is* its health — and wired it correctly: the page
loads `content.js` → `engine.js` → `render.js`, the author's `CONTENT` declares
the same 800×500 canvas the interface put in the markup, `engine.js` exports
`window.game` and calls `renderFrame()`, and `render.js` exports `renderFrame`
and reads `game` and `CONTENT` without mutating either.

That contract was agreed by three agents in two channels who never spoke
directly, which is the measurement this scenario exists to make.

The most valuable single artefact was the tester's `defects.md`. It found a real
defect no parser could catch — `movementKey()` lowercased only single-character
keys, so `'ArrowUp'` never matched the lowercase `switch` and half the declared
control scheme was dead — traced it to a line number, proposed a one-line fix,
and the lead carried it from `studio` into `build`, where the builder patched it
and the tester verified it closed. It then wrote a section headed **"Not
verifiable this run"** listing what nobody could know without executing the page.

That last part is `check_syntax` telling the truth about its own limits and the
agent repeating it rather than reporting a clean parse as a working game. It is
the strongest argument for keeping the honest sentence in the tool output, and
against ever letting a passing check read as a passing build.

### The full twenty-round run

58 minutes, 220 turns, 408 tool calls. Seven files, 1,039 lines, five distinct
writers, 33 checks run, **zero problems and zero refusals of any kind** — no
patch missed its target, no agent reached for a file that was not theirs, no
budget or path rule fired.

The headline number is the awkward one: **`roundsWithNoWrite` was 11 of 20.**
Read cold that says the team spent over half the run talking instead of
building. Read against the artifact it says something else entirely — the team
declared `design.md` "v1 — COMPLETE" and the tester's round-20 check confirms
every code file was *byte-identical to round 3*. They finished early and spent
seventeen rounds verifying rather than churning.

**That metric cannot tell those two apart, and the difference is the whole
judgement.** It is the clearest example yet of why this scenario refuses to let
anything assert on its counters: `roundsWithNoWrite: 11` would fail a threshold
somebody set in good faith, on a run that did the right thing.

Two consequences worth acting on:

- **Twenty rounds is more than the `arcade` brief needs.** A five-agent team
  reaches a complete v1 in three. Either the brief has to ask for more, or the
  horizon should come down, or — most interesting — the last stretch should be
  given a different job than "keep going".
- **The ownership partition never bit.** Zero ownership refusals across 408
  calls in this run and 139 in the smoke. Nobody ever tried to write somebody
  else's file. That is either a layout clear enough to make the rule redundant
  or a constraint that is not currently under test, and the honest reading is
  that it has not yet been shown to do measurable work.

The second run invented a different game from the first on the same brief — a
snake-like "cooling solid trail" where your own path is both hazard and memory —
which is worth knowing before anybody reads one run as characteristic.

The tester's work is again the most striking artefact. It computed a tunnelling
analysis by hand — at the `dt` clamp of 0.05 s the ember steps 16 px per frame
against a 14 px hit radius, so a throttled frame rate could step over a trail
point — assessed it as edge-case-only, **declined to request a change**, and
labelled it "a reasoned limitation, not an observed bug. I have not observed it
at runtime (I cannot run the game)."

### The first jam run: theme NO GOING BACK

58 minutes, 220 turns, 654 tool calls. Eight files, 1,705 lines, and the run
ended with `playtest` reporting **0 console errors, animates, responds to
input** — the first artifact in this package that was verified to actually run
before anybody looked at it.

**The playtest loop closed a defect nothing else could see.** In round 1 the
tester ran it and got two `ERR_FILE_NOT_FOUND` against a canvas that was 100%
flat black, while `check_syntax` was passing clean. It diagnosed the cause from
the report — *"no JS exceptions from engine.js itself, so the engine loads and
its rAF loop is alive; there's just nothing to draw"* — the lead carried it into
`craft`, the interface wrote the missing `render.js`, and round 2 came back with
zero errors and a moving screen. Both earlier runs shipped a game nobody had
ever seen run.

**The model can read the frame description.** The tester reported
*"title screen renders — 'ONE WAY' text visible (bright cluster, ~2% of frame in
`#f0e0c0`)"*, which is the ASCII luminance grid and the colour histogram being
used exactly as intended.

**Naming each theme's laziest reading works.** `no-going-back` declares its
shallow reading as "auto-scrolling in one direction". The lead's round-one post
locked the concept with *"**ONE WAY.** We are NOT doing auto-scroll"* — it
rejected the named trap by name. The tester then began treating theme adherence
as a correctness property, filing a defect that the starting cell was never
burned and calling it *"a literal 'going back' hole in the theme"*, which the
builder fixed.

**The jam clock helped.** `roundsWithNoWrite` fell from 11 of 20 to **5 of 20**
against the previous run's twenty rounds of the same brief. The phases give the
back half of the jam a job other than "keep going".

Two numbers that are warnings rather than wins:

- **37 of 65 patches were refused.** This run predates the indentation fix
  above, and it is the same defect measured at scale: more than half of every
  attempt to edit a file surgically failed on whitespace the tool itself had
  added. Expect this to fall sharply on the next run; if it does not, the
  diagnosis was wrong.
- **The run stalled on `max-rounds`.** One turn hit the 20-tool-round ceiling.
  A `playtest` costs several seconds and a long result, so a turn that checks,
  plays, reads and patches can run out of rounds before it runs out of things
  to do. Worth raising for this scenario specifically.

Context cost more than doubled, to **23.6M input tokens against 314K output**,
which is what running the game and reading the result costs.

One reporting caveat found while reading this run: the `code` line in a report
records the git sha at the moment the report is *written*, not at launch. This
run is labelled `fee15cf`, a commit made seven minutes after it started, so it
did not play the code its own report names. Harmless when the tree is clean and
misleading during an iteration loop.

### The second jam run, and the fix measured against the first

Two 220-turn runs of the same scenario, one before the indentation fix and one
after, with near-identical patch volume. This is the cleanest comparison the
package has produced for a tool change:

| | run 1 (NO GOING BACK) | run 2 (IT GROWS) |
|---|---|---|
| patch attempts | 102 | 109 |
| **refused** | **37 (36%)** | **10 (9%)** |
| `outline_file` | 4 | 16 |
| `playtest` | 33 | 58 |
| rounds with no write | 5 of 20 | **0 of 20** |
| stalled on tool rounds | yes | no |
| wall clock | 58 min | 84 min |

**A four-fold drop in patch refusals.** Worth recording that the interim reading
at turn 49 was 20% and prompted a premature correction here — a partial rate on
a run whose team is still creating files is not the rate. Wait for the horizon.

**`outline_file` finally earns its place**, four times more used. It was written
for the file that has grown too big to read and was almost ignored in every
earlier run; a refusal that shows the real text seems to have taught the shape
of the file as a thing worth asking about.

**No idle rounds at all.** `roundsWithNoWrite` has now gone 11 → 5 → 0 as the
jam clock arrived and then the tools stopped wasting turns. The scheduling
problem the first twenty-round run exposed is closed.

**Raising `--max-tool-rounds` from 20 to 30 removed the stall and cost 45%
more wall clock.** A turn that checks, plays, reads and patches genuinely needs
the rounds; the price is that a run is now 84 minutes rather than 58. Both
numbers belong in any future budget.

**The tool changed how the team works, unprompted.** The builder added
`window.GAME_DEBUG` hooks — `forceGameOver()` and `spawnBigPest()` — *for the
tester to drive from a playtest*. Nobody asked for that. Giving one role the
ability to run the game made another role start building affordances so it could
be driven, which is what a real team does and something no earlier run
approached.

One defect noted and not chased: a single post of 38 arrived with no attributed
author, an envelope with no speaker. It lives in core's envelope parsing rather
than here, and on a `review:` row nothing asserts on `posts_by`, so the only
cost is that the viewer cannot filter that line by agent.

### Two things to watch rather than fix

- **Read amplification.** `read_file` was 47 of 139 calls in the smoke and 94 of
  408 in the long run, which spent **10.6M input tokens against 199K output**.
  Prefix caching absorbs much of it, but the team's default move is to re-read a
  whole file rather than navigate it.
- **`outline_file` is nearly unused** — zero calls in the smoke, three in a
  twenty-round run. It exists precisely for the file that has grown too big to
  read, and the team barely reaches for it.

## Images: resolved 2026-08-21 (it was a TAI limitation, not a model one)

Recorded because this document asserted the opposite and the assertion was
wrong. `playtest` describes the screen in text, and the original reason given
was that the serving model could not see. Checked on 2026-08-20 rather than
assumed:

- **The weights have vision.** The artifact being served is tagged
  `image-text-to-text` and `multimodal`, and its card says the file contains
  "the registered Text, Vision, MTP, optimized proposal-head, tokenizer" and
  accepts "image, multi-image, video, and mixed multimodal messages".
- **The server supports it and has it switched off.** `ninfer-serve` takes
  `--vision`, which "enables media and loads the fixed Vision GPU allocations".
  The running container was started without it, so a request carrying an
  `image_url` part returns `400 vision_disabled` — *"Vision is disabled for this
  server"*, which is a setting rather than a capability.
- **TAI has no image path at all.** `ToolResult.output` is a `string` and
  `ChatMessage.content` is `string | null`, with no content-parts array. There
  is nowhere to put an image between a tool and a model.

So the ceiling was ours. Supporting image input was a core change of real scope
— a content-parts shape on `ChatMessage`, a way for a `ToolResult` to carry
media, provider mapping for at least the OpenAI-compatible dialect, and a
history-trimming policy for messages that are expensive and not summarisable.
It was a platform capability rather than a workshop feature, which by this
repo's own tiering made it a seam that should land on its own merits and not as
a dependency of one benchmark scenario.

### All three were cleared on 2026-08-21

That is what happened, in that order and on those terms.

- **The platform seam landed on its own merits** as `#546`, media support —
  content parts, a `MediaStore`, per-model capabilities, and the trimmer pricing
  a media part at 1,500 tokens. See [media-design.md](./media-design.md).
- **The server flag went on.** `--vision` costs about 10% of the KV pool
  (187,712 tokens → 169,600 at `--max-concurrency 4`, which is ample: the
  workshop's agents take turns and never run concurrently). The model then
  described a real screenshot down to the HUD text.
- **One thing was still missing**, and it is the interesting one, because it was
  invisible from every direction. `toOpenAIMessages` flattened *every* message
  to text, including the follow-up user turn that
  `adaptForCapabilities` synthesizes precisely to carry the image, while the
  provider declared `toolResultMedia: { supported: true, mode: "follow-up" }`.
  So the relay was declared, performed and then silently discarded at the wire.
  The tell was a 960×720 screenshot billing 244 prompt tokens. Fixed in the same
  change; the full account is in
  [media-design.md](./media-design.md#the-half-of-that-workaround-that-shipped-without-the-other-half).

`playtest` now returns two real frames — the opening screen and one taken
mid-play — beside the report it already wrote.

**The text description survived, as predicted.** It is small, it diffs cleanly
frame to frame, and a line like "6.6% of the frame is not background" stays
useful after a history trim in a way an image does not. That last clause is now
load-bearing rather than rhetorical: core evicts a media part at 1,500 tokens a
piece, so on a long jam the sentence is what remains of a frame nobody can see
any more. Both are sent, which was the predicted end state.

## They no longer write the game loop every time

Added 2026-08-21, and it is the first change here aimed at the *games* rather
than at the benchmark.

Every jam before this one started from an empty directory and hand-wrote a
fixed-timestep loop, keyboard edge detection, a particle emitter and a seeded
random. Most wrote the naive version of each, because the correct version always
loses to "make the collision work first" and then the jam ends. That is a few
hundred lines a run spent on the part of a game nobody plays.

So the arcade brief now ships `lib/` — four files, ~580 lines, present from
round zero:

| file | global | what it removes |
|---|---|---|
| `lib/loop.js` | `Loop` | a loop tied to the monitor: same game twice as fast at 120Hz |
| `lib/input.js` | `Keys` | OS auto-repeat read as forty jumps, and a key held through a blur |
| `lib/draw.js` | `Draw` | flat discs. `Draw.orb` is a shaded sphere in one call |
| `lib/fx.js` | `FX` | the polish round having nothing to spend itself on |

**It is not a framework and it is not optional-looking.** The brief carries a
one-screen API summary rather than making anyone read 580 lines to discover
there is a game loop, and it says outright that a game using none of it will
lose to one that does.

### The accounting is the part that had to be right

A provided file is scenery, not output. It is excluded from `filesPresent`,
`linesInWorkspace`, `bytesInWorkspace`, the 400,000-byte budget and the file
cap — otherwise every measurement of what a team produced would be incomparable
with the eight entries built before the library existed, and a fifth of the
workspace budget would be spent before round one.

Two consequences worth knowing:

- **Writes are refused for everybody, in every arm**, including the solo one
  where ownership is off. "You cannot edit the library" is not an ownership rule
  between teammates; it is what makes the library the same fixed thing for every
  entry on the board.
- **`files.length > 0` decides whether to publish.** Counting provided files
  there would publish an empty entry for a team that wrote nothing, since the
  library is present in every run from round zero. That one is a real bug that
  the accounting rule prevents rather than a tidiness argument.

`WORKSHOP_VERSION` moves to `workshop-4-library`. Entries built before it played
a different game and the board says so.

**What this costs:** the scenario measures less engineering than it did. That is
a deliberate trade, made because the arcade's purpose has shifted from "watch a
team build software" toward "produce games worth playing". The from-scratch
briefs (`tool`, `site`) are untouched and still declare no library, so the
original game is still available as an arm.

### The builder was given eyes too

Not part of the image work, but found by the same investigation. `playtest`
belonged to the tester and the interface. `check_syntax` is the deliberately
artificial constraint — the one that makes "has anybody verified this" a
question the team has to notice it should ask — and `playtest` was added later
and inherited its role list without inheriting the argument for it. The
consequence was that the agent writing the game loop could not look at the game.

It was not a hypothetical handicap. In the seed-11 jam the builder **called
`playtest` twice and was refused both times**, while the tester ran it 16 times
and the interface 10. The agent writing the game loop asked to see the game,
was told no, and stopped asking.

The measurement that settled it, across the four jams before the change:

| Run | Workspace stops growing | Final code lines |
|---|---|---|
| seed 14 | round 3 of 20 | 428 |
| seed 11 | round 14 of 20 | 1,196 |

And across those runs, **44–52% of every agent turn was an explicit `room`
action of `pass`** (96 of 220 turns in one, 114 of 220 in the other), with
another 37–38% of tool calls spent re-reading files that had not changed. Only
10–12% wrote anything.

### What it changed, measured

One sighted run (seed 21, theme *KNOT*) against the two complete blind runs at
the same 220 turns:

| | seed 14 (blind) | seed 11 (blind) | seed 21 (sighted) |
|---|---|---|---|
| turns ending in `pass` | 96 (44%) | 114 (52%) | **49 (22%)** |
| calls that build | 62 (10%) | 64 (12%) | **90 (15%)** |
| playtests | 0 | 28 | 29 |
| frames reaching a model | 0 | 0 | **58** |
| code lines at round 11 | 423 | 712 | **1,037** |
| final code lines | 428 | 1,196 | 1,514 |

The `pass` rate more than halved and stayed halved — 22% at turn 60, at turn 140
and at the end, so it is not a fast start decaying into the old behaviour. The
plateau moved: seed 14 was frozen from round 3, seed 21 was still adding code at
round 8 and had half again as much of it by round 11.

**The line counts are the least interesting row here**, and are reported mainly
because they are what a plateau is measured in. Seed 11 finished within 300
lines of seed 21 and the two artifacts are not comparable to look at: seed 11's
is a sparse field of primitives, seed 21's has shaded balloons on tethers, drawn
clouds, a strain indicator and a HUD that fits the game. The honest summary is
that a team which can see its own screen spends its rounds on how the screen
looks, which is not a thing this table can hold. That is what the arcade and a
human reviewer are for.

One caveat worth keeping: this is **n=1 against n=2**, on a benchmark whose
own noise floor is documented at ~2.6 points of swing on identical code. The
`pass` collapse is far too large to be noise and is stable across three
sampling points; the line counts are well inside it. This is CLAUDE.md's own rule about
instructions that offer a way out, showing up in a place nobody had looked for
it — but the deeper cause is that a team which cannot see its game has no way to
falsify "it is finished", so it idles out the clock. More rounds buy more of the
same; the fix is a signal, not a budget.

## Watching it

**Today: the developer viewer at `/`, unchanged, zero lines of new code.** Its
generic fallback board filters the snapshot to non-objects and renders what is
left — its own comment says a new simulation should be watchable the day it is
written — and its milestone and fact panels degrade to "No ladder." and "No
tracked facts." So the workshop's snapshot puts every counter at the **top
level** as a scalar, with the file tree and recent edits nested underneath.

**Not reused: `/broadcast`.** It is ~13,000 lines across twelve modules and
every one of them draws a dungeon — `floorplan`, `spoils`, `zones`, `betrayal`,
a `Scene` contract with `floor`, `party`, `enemies` and `phase`. Extending it
means a discriminated scene union threaded through all twelve or a second stage
sharing only the shell. Not phase-one work.

**Phase 3: `/workshop`.** A third page beside `/` and `/broadcast`, sharing the
server, the `/events` endpoint and the rule that the viewer never writes
anything. The room transcript, a file tree with per-round churn, a round ribbon
of check status, and — the reason to build the page at all — **the artifact
live, in a sandboxed iframe**, pointed at the latest round snapshot. Watching a
canvas go from black to a moving ship over twenty rounds is a different artefact
from watching a log.

### That iframe runs model-written code in your browser

Stated plainly because the commit before this work made the broadcast viewer
network-accessible. Non-negotiables for that panel:

- `sandbox="allow-scripts"` and **not** `allow-same-origin`. Together those two
  are equivalent to no sandbox at all.
- Serve snapshots from a dedicated path with `Content-Security-Policy: sandbox;
  default-src 'none'`, never from the viewer's own origin's asset tree.
- Off by default, behind a toggle that says what it does.
- When `watch` is bound to anything but `127.0.0.1`, refuse to serve artifacts
  unless a flag says otherwise. A broadcast on the LAN is fun; a broadcast on
  the LAN that runs generated code in every viewer's browser is not.

## Build order

| phase | what | state |
|---|---|---|
| 1 | `review: true` in the schema, `score()`, the report block | **done** |
| 1 | `sim/workshop/`: workspace, tools, ownership, snapshots, metrics | **done** |
| 1 | three briefs, layout and ownership as data | **done** |
| 1 | `scenarios/25-the-workshop.ts` + two control arms | **done** |
| 1 | scripted policy and `scripts/workshop-rehearse.ts` | **done** |
| 1 | watch through the existing `/` viewer | **done** (nothing to build) |
| 2 | `eval review` and a `review.html` bundle | planned |
| 3 | `/workshop` page with the live iframe | planned |
| 3 | narrator brief seam (`narrate.ts` is reusable but dungeon-prompted) | planned |
| 4 | `playtest()` in a container: headless run, console errors, screenshot | planned |

The next thing to do is **run it once** and read what comes out. Everything
after phase 1 improves the review rather than enabling it, and the cheapest
possible answer to "is this worth more work" is available before any of the
expensive parts.

## The arcade, and what changed when the output got a home

Full notes in [docs/arcade.md](./arcade.md); what matters here is what it changed
about *this scenario*.

The eval as originally built produced a directory and a markdown scorecard per
run. That is the right shape for one run and the wrong shape for thirty, which
is what running the jam on a loop produces — and every question worth asking of
thirty runs (*did theme relevance improve*, *is this model reliably worse at
polish than at gameplay*) is a query rather than a read.

Three things followed.

**Registration became part of the task.** The lead now has to write the page a
judge reads before playing — title, pitch, genre, what it is, how to play — and
a run that finishes a working game and never registers it is a visible, countable
failure rather than an absence. `arcadeRegistered` is a metric; `announce()` says
so once the jam is 70% gone and not before, because nagging from round one trains
a team to read past the line.

**The teams can see previous entries and their scores.** This is the change with
the sharpest experimental consequence and it is a genuine confound: a team that
can read what scored well last week is playing a different game from one that
could not, so the imported backlog and everything after it are **not one series**.
`arcadeBrowses` and `arcadeReads` record who actually looked, which is the only
reason this is testable rather than merely true.

**Six categories became five, and moved.** `polish` and `technical soundness`
were never independent — the same cause produces both — and a judge asked to
separate them writes the same sentence twice. They now live in
`packages/arcade/src/categories.ts` as the single copy that the brief, the
artifact scorecard and the site's review form all read; three hand-maintained
lists would have drifted, and the failure mode is agents told they are judged on
one thing and scored on another.

### One bug worth writing down, because it happened twice

The arcade store is a real database outside the repo. The first version opened it
by default, and one test run wrote **forty-eight rows into it**, several
published, because the suite constructs this simulation forty-eight times and
`metrics()` publishes. Making the arcade opt-in — a `run` context from the
harness, or an explicit home — fixed that, and then a *test of the opt-in itself*
leaked seven more, because passing a `run` context is exactly what that test has
to do.

Twice is a pattern. The per-test home is the right knob and the wrong guard: it
protects the tests that remember it, not the ones nobody has written yet. The
guard is now a `beforeAll` in the test file that redirects `ARCADE_HOME` for
everything in it. The general shape — *a default that writes outside the process
is a default that will be triggered by something that never meant to* — is the
same lesson `TAI_HOME` taught, arrived at from the other direction.

## The measured ceiling, and what was done about it (2026-08-22)

Nine published games in, the output stopped moving. Every one of them landed at
1,200–1,550 lines across eight files, and OVERGROWTH reached 1,281 lines in
**fifteen** rounds — the same as the games that ran twenty. About a quarter of
that was markdown, so the game itself was 810–1,060 lines every time.

Three findings, all measured rather than inferred:

**The teams were finishing early and then verifying.** On ONE (seed 24, a
twenty-round sighted run), rounds 4–11 carried 74% of all edits and rounds 12–20
carried 13.5%. The late rounds are not a team that ran out of road; they are a
team that knows it is done. The lead says "Game is finished and verified" at
round 14 and **"FREEZE THE CODE"** at round 19, and the author spends a turn
reading all 99 lines of its own file to confirm nothing changed.

**The layout was the architecture.** All twelve entries produced a byte-identical
file set — `content.js defects.md design.md engine.js index.html render.js
style.css submission.md`. Not one team ever created a file the brief had not
named, or declined one it had. `content.js` is specced as "Levels, tuning
constants, colours, copy" and came back as 97–99 lines of pure tuning constants
in every single game: no levels, no enemy types, no items.

**Half the jam was structurally forbidden from adding anything.** The phase
ladder said CONCEPT below 0.2 ("do not start building"), POLISH from 0.7 ("no new
features") and SUBMIT from 0.9 ("freeze the code"). Only 0.2–0.7 was BUILD — ten
rounds of twenty — and teams stopped around 0.6 regardless.

The tempting fix was to raise the bar in `doneLooksLike`. That is the same
disease: it would have produced twelve identically *bigger* games. Two changes
went in instead.

### Versions: submitting a build without ending the jam

`submit_version` puts the workspace on the arcade as a numbered build and the
team keeps working. The entry becomes `published` on the first submit — that is
what submitting means at a jam — but stays `live`, so heartbeats keep landing and
the site can say "playable, still building".

**The last submitted build is the one judged**, not the final state of the
workspace. A team that ships `0.4.0`, starts `0.5.0` and is mid-refactor at the
horizon has `0.4.0` judged. This is the rule that makes submitting early rational
rather than merely permitted, and it is why publishing the raw workspace would
have been wrong: an unfinished edit at the end could otherwise destroy a good
build already on the board.

It also removes the reason the freeze existed. With one publish at the horizon,
stopping early and proving the thing still worked *was* the correct play. With
versions it is not, so the phase ladder could go too.

### `direction=open`: a brief that says what, not how

The open arm — now the default — plans no files at all. `list_files` starts
genuinely empty and the brief reads roughly as a jam brief does: build the best
game you can, on the theme, in a browser, with a keyboard.

Ownership is kept, because partitioned write access is the variable this
scenario exists to test. It is just no longer handed over: roles take files with
`claim_file`, first claim wins, and a second claimant is refused and told who to
ask. Writing an unclaimed file claims it, so round one does not deadlock on a
tool nobody remembered to call — the tool is for reserving a file before it
exists, and the auto-claim covers the far more common case of somebody simply
starting.

`openConstraints` carries the subset of the rules that survives. One canvas and
no image files are properties of the medium and stay; "at most one action key" is
a decision about the game and goes.

**`direction=prescribed` keeps the old behaviour as a control arm**, because
de-prescribing is not obviously an improvement. A team handed a layout has
orientation on turn one; a team that has to invent one may spend rounds on it and
arrive somewhere worse. The sameness is not in question — twelve identical file
sets settle that — but whether the games get *better* is, and only a pair of arms
on the same code can answer it.

### The backstop, and the tool grant that made it necessary

`submit_version` goes to one role only — whoever writes the submission — and that
is deliberate, for a reason the first live run measured: when the arcade tools
were shared, the *interface* agent spent four of the team's six tool calls
browsing the board and reading previous entries, and the run wrote no files at
all. A cheap, interesting, public tool is one every agent calls once, and once
times five roles times twenty rounds is a lot of sightseeing.

That leaves the whole point of versions resting on one agent remembering. At a
natural end nothing is lost, because `publishRun` falls back to the workspace —
so the exposure is exactly the case versions exist for: a run killed mid-jam,
which is how OVERGROWTH came to be published by hand.

So a **clean playtest checkpoints the workspace**. It costs no turn, no schema
entry and nobody's attention, which is what makes it affordable where handing the
tool to five roles was not. It fires only when the game actually runs — no
console errors, animates, responds to input — because a saved black rectangle
that parses is what would get judged if the run then died, and only when there
has been new work since the last build, or the history fills with noise.

Checkpoints are marked `auto` on the row and counted as `arcadeAutoSubmits`,
apart from the deliberate ones. A run whose only builds are automatic is a run
where the mechanism did not land, and that has to be visible rather than hidden
inside a healthy-looking total.

### The deadlock that cost a run, and the rule that replaced it

The first live open-arm run (seed 26, 2026-08-23) died at round 7 with **one file
on disk**. The builder claimed `game.js` at round 2 and then wrote nothing for
five rounds — 14 turns, 14 `read_file` calls, zero writes, zero posts.

The team did everything right. The tester escalated with real tool output every
round; the lead set a hard deadline and authorised a handoff; the author
volunteered to take over. The workspace refused them **eleven times**:

> `game.js` is already the builder's.

`claim_file` had no release, no expiry and no reassignment, so a claim was a
freehold and one quiet agent could freeze the jam. The same shape had already
happened once in the prescribed arm — WAKE (seed 23) shipped with no `engine.js`
because its builder produced nothing and nobody else could write the file — and
it was not recognised as the same bug at the time.

The rule now is one sentence: **claiming reserves a name, writing makes it
yours.**

- A claim on a file that still does not exist **lapses after two rounds**, and
  the round announcement says so in as many words: `FREE TO CLAIM: game.js (the
  builder reserved it and never wrote it)`. Automatic, because the failure it
  fixes is an agent that has gone quiet, and a quiet agent will not release
  anything — any mechanism needing the holder to act cannot solve the case where
  the holder *is* the problem. Announcing is half of it: a claim that lapses
  silently leaves the team believing the file is still spoken for.
- **`release_file`** hands a file back. Anybody may release their own; the lead
  may release anybody's, which is precisely what the deadlocked team tried to do.
- A file that **exists** never lapses. Write it and it is yours for as long as
  you want it.
- Assignments from the brief in the prescribed arm carry no claim timestamp and
  are never touched by any of this.

`claimsLapsed` is the counter that makes the failure legible rather than
mysterious: high, next to low `writes`, is a team blocked on somebody who stopped.

### Proving it without a model

`pnpm exec tsx packages/evals/scripts/workshop-rehearse.ts` runs the whole thing
against a scripted bot in about a minute and now covers the new paths: claiming a
file, having a second claimant refused, submitting, doing more work, submitting
again, and a role without the tool trying to. It publishes into a throwaway
arcade under `results/rehearsals/` — never `~/.tai-arcade`, because a scripted
bot's output must never reach the board a person reviews — and prints what landed:

```
  220 turns, 8 files, 60 lines
  submitted 2 build(s), 0 automatic; 8 claims, 1 ownership refusals
  board     workshop-workspace — published, 2 build(s) kept
              0.2.0 r13 — longer waves
              0.1.0 r11 — it runs
```

The backstop itself is covered by tests rather than the bot, which never calls
`playtest` because it is a real browser and slow.

Read `claims` against `ownershipRefusals` (claims low and refusals high is a team
that started writing before it divided the work) and `arcadeSubmits` against
`roundsWithNoWrite` (one submit at the end is the old behaviour wearing a new
tool; five is a team that stopped treating the horizon as a cliff).

## What it cannot tell you

- **Runs are not comparable with each other.** Two runs on the same brief differ
  by sampling and there is no seed that fixes it, because there is no world to
  seed. Every conclusion is a case study. Say "in this run", never "the model
  does".
- **Model priors dominate.** Treat a suspiciously polished artifact as evidence
  of memorisation until shown otherwise.
- **A reviewer is not a stable instrument.** You will be more generous at 9pm
  than at 9am.
- **Syntax-clean is not working**, until phase 4 exists.
- **Attribution is a judgement.** A bad artifact could be the model, the prompt,
  the tools, the history budget or the brief. The counters narrow it; they do
  not settle it.

## Open questions

1. **Is `arcade` the right first brief, or the most flattering one?** Games are
   the most memorised artifact class there is. `site` is the more honest first
   test and the worse demo.
2. **Should the lead be able to write code?** As shipped it cannot, which is
   clean and possibly wastes the strongest agent in the room.
3. ~~**Twenty rounds with no definition of done means the team never has to
   converge.**~~ Answered, and backwards: the definition of done was too *small*,
   not absent. Teams satisfied it by round eight and spent the last third
   verifying. See the measured ceiling above.
4. **Where does the reviewer's verdict live?** Nowhere, today. If reviews are
   worth keeping they want a file in the workshop directory and a line in the
   history board — which is one step from a score, and should be resisted or
   embraced deliberately rather than by drift.

## Where the pieces are

| what | where |
|---|---|
| the directory, path rules, snapshots, outline | `packages/evals/src/sim/workshop/workspace.ts` |
| parse-only checking | `packages/evals/src/sim/workshop/check.ts` |
| the briefs, layouts and ownership | `packages/evals/src/sim/workshop/briefs.ts` |
| submitted builds, and which one is judged | `packages/arcade/src/publish.ts`, `store.ts` |
| tools, roles, metrics, `briefFor` | `packages/evals/src/sim/workshop/index.ts` |
| the scripted bot | `packages/evals/src/sim/workshop/policies.ts` |
| the three scenarios | `packages/evals/scenarios/25-the-workshop.ts` |
| a trace without a model | `packages/evals/scripts/workshop-rehearse.ts` |
| `review:` and its rules | `packages/evals/src/schema.ts`, `report.ts` |
| tests | `packages/evals/src/__tests__/workshop.test.ts` |
