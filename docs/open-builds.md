# Open builds — a scenario with a brief instead of a score

A plan, not a built thing. Nothing in this document exists yet.

## The idea

Five agents, one room, a brief — *make a video game* — and forty rounds. At the
end there is no number. There is a directory with something in it, a transcript
of how it got there, and a person who opens it and forms an opinion.

This is the endless descent with the dungeon replaced by a workspace and the
score replaced by a reviewer. Every other scenario in this package answers a
question the package itself can settle: did they reach the state, beat the
baseline, earn the experience. This one asks the question the package cannot
answer and that nothing else here is even shaped to ask — *is what they made any
good* — and hands it to the only instrument that can: somebody looking at it.

It is worth building for three reasons that have nothing to do with scoring.

**It is the only scenario where the artifact outlives the run.** A descent run
leaves a number and a trace. A build run leaves a thing you can open. That
changes what a bad run tells you: "scored 2,883" is a fact about a benchmark,
and "the movement code is fine and nobody ever wrote a collision check" is a
fact about the framework.

**It runs long enough to break the memory story.** Forty rounds at five agents
is two hundred turns, and the history budget will trim the early conversation
out from under them. Whether the team stays coherent past that point is
currently unmeasurable: the descent's memory diagnostic gets "roughly one
opportunity per run" (see [endless-descent.md](./endless-descent.md)). Here the
workspace *is* the memory, and a team that forgets what it agreed in round four
will contradict itself in a file you can read.

**It has no ceiling to reach and no answer to re-author.** Same founding
argument as the descent, arrived at from the other side: `the-lock` cost a
session to write and was beaten in four runs. A brief cannot be beaten. It can
only be executed better.

## Most of this is already built

The descent's machinery is domain-agnostic in every place that matters, and the
seams were drawn by somebody who had already been burned by them being drawn
wrong. What a new scenario of this shape inherits for free:

| what | where | works unchanged? |
|---|---|---|
| roles → per-agent tool grants | `harness.ts:simulationGrants` | yes |
| a room, a roster, N rounds | `harness.ts:runRoomScenario` | yes |
| the round announcement that stops agents sleeping | `Simulation.announce()` | yes |
| NDJSON trace: rounds, turns, calls, posts, state | `trace.ts` | yes |
| the developer viewer at `/` | `viewer/index.html` | yes, generically |
| live watching, finished-run reading | `watch.ts` | yes |
| worker isolation, cost accounting, retries | `worker.ts`, `cost.ts` | yes |
| an observer-only narrator | `narrate.ts` | prompt is dungeon-specific |
| the broadcast at `/broadcast` | `viewer/broadcast/` | no — it draws a dungeon |
| scoring, milestones, `expect` | `graders.ts`, `report.ts` | deliberately not used |

The genuinely new work is a simulation whose world is a directory, a schema flag
that lets a scenario decline to be scored, and a review surface. Everything else
is configuration.

## What "no score" has to mean, mechanically

Today a scenario cannot decline to be graded. `expect` is `z.array(assertion).nonempty()`
and the superRefine insists each entry carry exactly one assertion, because a
typo that grades nothing is a scenario that passes for having checked less.
That rule is right and should not be weakened. The way through is to say so
explicitly:

```ts
// schema.ts
review: z.boolean().optional(),
// and, in the scenario superRefine:
//   review === true  →  expect may be absent
//   review !== true  →  expect is required and nonempty, exactly as now
expect: z.array(assertion).nonempty().optional(),
```

`review: true` then has to propagate:

- **`report.ts:score()`** skips these scenarios entirely. Not "counts them as
  passing" — a review scenario contributes `0/0`, the same way an errored one
  does, and the summary names it in its own line: *`the-workshop` — 1 run, not
  scored, review at `results/workshops/…`*.
- **`--min-score`** cannot be affected by a run nobody graded.
- **`readHistory`** already ranks by `objective()`, which a review simulation
  returns `0` from. Left alone, the scoreboard shows a column of zeroes and
  invites somebody to read them as a score. Give `RunRecord` an `unscored`
  flag off the trace's `run` event and have the board show activity columns
  (rounds, files, lines) instead of a rank.

The name matters slightly. `review: true` says what happens next; `qualitative:
true` says what kind of thing it is; `unscored: true` says what it lacks. Prefer
`review` — the scenario is not merely ungraded, it has a step after it.

### The trap this creates, stated before it is built

A simulation must implement `metrics()`, and metrics are numbers, and numbers
get ranked. The moment `linesWritten: 1840` appears in a report next to another
run's `1204`, somebody will conclude the first team did better, and they will be
wrong for a reason nobody wrote down. The descent has already been bitten by the
general form of this twice — a `pooledPurchases` heuristic calibrated against a
floor-one purse fired on every ordinary purchase, and an experience threshold had
to be re-derived twice as the balance moved.

So the metrics here are named for what they are — **activity, not achievement** —
and the report prints them under that heading. `filesTouched`, `patchesRefused`,
`roundsWithNoWrite`, `ownershipRefusals`. Every one of them is a fact about
process. None of them is allowed into `expect`, and `sim_metric` assertions are
rejected at load time on a `review` scenario.

## Decision 1 — the world is a real directory, reached through simulation tools

The obvious approach is to un-stub core's `write`, `read`, `edit` and `exec` for
this scenario. It is wrong, for a reason the harness already documents:
`STUBBED` exists to catch *anything that reaches outside this process*, and
loosening it is a change to every scenario's blast radius, not just this one's.

Simulation tools are the seam that already handles this. They are passed through
`instrument(…, "never")` and are never stubbed, precisely because they have a
real implementation and it is the thing under test. So the workspace tools are
the simulation's tools, and the simulation owns the directory.

Two consequences worth writing down now rather than discovering:

**Names must not collide with core's.** On 2026-08-18 the descent's `read`
collided with core's file-reading `read`, the model called it in round three,
and the call was answered with *"(stubbed in the benchmark — assume it succeeded
and continue)"* while the metric it fed stayed at zero. `read`, `write`, `edit`
and `exec` are all taken. Use `read_file`, `write_file`, `patch_file`,
`check_syntax`.

**The workspace cannot live in `TAI_HOME`.** `runOnce` builds the home with
`mkdtempSync` and `rmSync`s it in a `finally`. An artifact written there is
deleted at the moment the run ends, which is the moment somebody wants to look
at it. The workspace goes beside the traces instead:

```
packages/evals/results/workshops/<scenario>-<iso-timestamp>/
  brief.md               written by the harness, read-only to agents
  workspace/             everything the team writes
  rounds/03/             a snapshot taken at each round boundary
  transcript.md          rendered after the run
  review.html            the review bundle
```

`results/*` is gitignored except the published cohort, so none of this can
accidentally become a committed artifact.

## Decision 2 — the deliverable is one self-contained HTML file

The brief should ask for a game that is a single `index.html` with inline CSS
and JS, canvas or DOM, no imports, no build, no package manager, no network.

This is not a limitation dressed up as a decision. It buys four things at once:

- **No toolchain means no toolchain failures.** A run that spends eleven rounds
  fighting `npm install` has measured npm.
- **Review is a double-click.** The reviewer is the instrument; anything between
  them and the artifact is friction that will silently reduce how often this
  eval actually gets run.
- **Verification needs no execution.** `node --check` on the extracted script
  and an HTML parse is the whole correctness gate (see decision 3).
- **The broadcast can show the game.** A self-contained file drops straight into
  a sandboxed `<iframe>`, which turns the watchable surface from "a transcript"
  into "the thing they are building, growing, round by round". Nothing else on
  this list is as valuable as that one.

It also keeps the brief honest about scope. Five agents and forty rounds is not
enough for an engine; it is enough for one good arcade loop, and asking for one
good arcade loop is what makes the review meaningful.

## Decision 3 — no code execution in v1

`check_syntax` parses; it does not run. For each file in the workspace: parse the
HTML, extract `<script>` bodies, and run them through a parser (`node --check`
via `spawnSync` on a temp file, or `acorn` in-process — prefer in-process, no
subprocess at all). Return errors with file, line and message. No network, no
subprocess, no timeout to tune, no sandbox to configure.

What this costs is real and should be stated in the brief so the agents know:
**nobody can tell whether the game plays.** Syntax-clean and logically broken is
a run that ends with an artifact that opens to a black screen. That is a genuine
finding, not a failure of the eval — it is what a team with no playtest loop
produces — but it caps how good the output can get.

When it is worth spending: core already has a sandbox registry
(`packages/core/src/sandboxes/`, host/docker/podman) and
[docs/sandboxes-and-worktrees.md](./sandboxes-and-worktrees.md). A v2
`playtest()` tool runs the page in headless Chrome inside a container, drives
synthetic input for N frames, and returns console errors plus a screenshot. That
is a week of work and it is the single biggest quality lever available. It
belongs in phase 4, after the cheap version has proved the shape is worth it.

## Decision 4 — editing is surgical, or the run dies of context

This is the detail most likely to decide whether the output is any good, and it
is not a design question but an arithmetic one.

A whole-file `write_file` means every edit to a 900-line game file puts 900
lines into the request and 900 lines into the response. A descent run on
2026-08-17 reached 44,913 tokens against a 32,768-token server and died at round
13. A build scenario walks into that by round six unless the tools are shaped
against it:

| tool | why it exists |
|---|---|
| `patch_file(path, find, replace)` | the primary editing tool: str-replace, one occurrence, refuses on zero or multiple matches |
| `read_file(path, from?, to?)` | line-numbered slice, hard-capped at ~200 lines per call |
| `outline_file(path)` | top-level functions, classes and section comments with line numbers — how a 900-line file stays navigable |
| `write_file(path, content)` | full write, correct for creating a file and for a deliberate rewrite |
| `list_files()` | tree with line counts and last-touched-by |

`patchesRefused` — a `find` string that matched nothing — is the highest-signal
metric in the whole design. It is exactly the moment an agent's model of the
file diverged from the file, and counting it costs nothing.

Core's own `edit` tool (`packages/core/src/tools/edit.ts`) is the reference
implementation for the refusal semantics; the workspace version should match its
behaviour so the eval is exercising the same ergonomics production agents get.

Path containment is `packages/core/src/tools/path-containment.ts`, which is not
exported from core's index. Re-implement the ~20 lines inside the simulation
rather than widening a core export for a private package — this is tier-2 work
and should stay there.

## Decision 5 — the asymmetry a build task can survive

The descent's founding measurement is that difficulty in a multi-agent scenario
comes from the shape of the team, not the length of the chain — `the-machine` at
98/98 against its split sibling at 32/52/107 on the same model. Five agents with
identical tools and identical files are one agent with five prompts, and the run
will look like it.

But a build task punishes artificial asymmetry in a way a dungeon does not. Hide
the code from the person writing it and you get a worse artifact, and the
artifact is the deliverable. So the asymmetry has to be the kind real teams
actually have:

| role | writes | reads | uniquely |
|---|---|---|---|
| `director` | `design.md` only | everything | owns the brief's interpretation; cannot touch code |
| `engineer` | `engine.js` section of the page | everything | the game loop, input, state |
| `artificer` | `render.js` section | everything | drawing, colour, sprites, effects |
| `balancer` | `tuning.js` section | everything | constants, difficulty curve, scoring |
| `playtester` | `defects.md` only | everything | the **only** role that can call `check_syntax` |

Everybody reads everything. Write access is partitioned. That produces the
conversation the eval exists to watch — *"your loop calls `drawShip` with two
arguments and mine takes three"* — without degrading the artifact, because
nobody is ever blocked from *seeing* what they need.

The playtester holding `check_syntax` alone is the one deliberately artificial
constraint, and it is the most interesting one: it makes verification a thing
somebody has to *ask for*, which is where teams actually fail.

Make it a knob: `--sim-option ownership=strict|shared`. `shared` gives everybody
write access to everything and is the control arm for "did the partition help or
hurt". Expect to be surprised.

### Which file layout the partition implies

A single `index.html` with a partition across four files is a contradiction. Two
ways out, and the second is better:

1. Agents write four `.js` files and the simulation concatenates them into
   `index.html` at each snapshot. Clean partition, and it hides a real class of
   bug (load order, scope) from the team.
2. Agents write four `.js` files plus `index.html`, and the page loads them with
   four `<script src>` tags. The *review* artifact is then a directory, not one
   file — still a double-click, still no build, and the iframe preview still
   works because the watch server serves the directory.

Take option 2. Give up "one file" and keep "no build". The brief says *a folder
you can open `index.html` from*.

## The brief is data, not a scenario

`--sim-option brief=arcade-shooter`, resolved from `src/sim/workshop/briefs.ts`,
plus `--sim-option brief-file=./my-brief.md` for an ad-hoc one.

This is the whole reason to build the simulation rather than a one-off scenario.
The descent exists because a benchmark with an answer has to be re-authored every
time it is beaten. A build scenario with a hardcoded brief has the same disease
in a milder form: *make a video game* is one sample of one task type, and the
first thing anybody will want after reading the output is to try a different
brief. Shipping three from the start proves the seam:

- `arcade-shooter` — the reference brief, tight scope, obvious success criteria
- `roguelike-tutorial` — needs procedural generation and state that persists
  across screens; a much harder coordination problem
- `dashboard` — not a game at all: read a bundled CSV and draw four charts.
  Included specifically to check that the machinery is not secretly a game
  framework

A brief is a markdown file with a goal, a hard constraint list, and an explicit
"done looks like" paragraph. It goes into every agent's instructions and is
written to `brief.md` in the workspace so it survives history trimming.

## The round loop

Almost nothing to build. The simulation implements the existing interface:

```ts
runsOnUnattended = false;   // a workshop with nobody in it does nothing
advance()  → SimEvent[]     // round boundary: snapshot the workspace, tick the clock
announce() → string         // "Round 7 of 40. 5 files, 812 lines. Last check: 2 errors."
done       → day >= horizon // there is no other ending
objective() → 0             // and the doc says why
metrics()  → activity counts, never achievement
snapshot() → { files, lines, checkErrors, roundsWithNoWrite, …, workshop: {…} }
```

The snapshot shape has one constraint worth knowing before writing it. The
developer viewer's generic fallback (`drawBoard`) filters the snapshot to
`typeof v !== "object"` and renders what is left as labelled cells — its comment
says outright that *a new simulation should be watchable the day it is written*.
So the headline numbers must sit at the **top level** as scalars, with the
structured detail (the file tree, per-agent activity) nested underneath for the
purpose-built page. Nest everything and the free viewer shows an empty board.

`announce()` is load-bearing rather than decorative, for the reason the harness
already documents: `pollOnce` runs no turn when a room has nothing new in it, so
on a round where nobody happened to post, every agent would sleep while the clock
ran to the horizon — and the report would show a team that chose to say nothing.

`runsOnUnattended = false` matters here for a second reason beyond the descent's:
there is no world process. Nothing happens in a directory that nobody is typing
in, so running on unattended would advance the clock and change nothing, which is
merely wasteful rather than wrong — but it would also let a run "finish" its
horizon with the roster exhausted, and the round count in the report would stop
meaning turns taken.

### The horizon and the 40-round cap

`wakeRounds.rounds` is capped at `.max(40)` in the schema. Two facts about that:

- It binds the *scenario file*, not the run. `clampRounds` runs over an
  already-validated scenario, so `--rounds 80` overrides it — that pair landed
  with the in-flight descent work and is uncommitted as of this writing.
- The comment justifying the cap says it exists to stop a single scenario costing
  more than anybody will wait for. For a review scenario the waiting is the
  point.

So: raise the cap to 200 **only when `review: true`**, and leave it at 40 for
everything scored. Forty rounds at five agents against the local model is roughly
two hours by the descent's measured ~35s/turn; eighty is most of an afternoon and
should be a deliberate flag rather than a committed default.

## Watching it

The user's ask included a broadcast, and this is where the plan is deliberately
staged rather than ambitious, because the existing broadcast is not reusable.
`viewer/broadcast/` is ~13,000 lines across twelve modules and every one of them
draws a dungeon: `floorplan.ts`, `spoils.ts`, `zones.ts`, `betrayal.ts`, a
`Scene` contract with `floor`, `party`, `enemies` and `phase`. Extending it to a
second world means either a discriminated scene union threaded through all twelve
or a second stage that shares only the shell. Neither is phase-one work.

**Phase 1 — the developer viewer, unchanged.** `viewer/index.html` is already
generic: it renders rounds, turns, calls, posts and state from any trace, has a
per-agent filter, and falls back to a generic board for scenarios it does not
recognise. It shows communication and progress on day one for zero lines of new
code. Start here; it may well be enough.

**Phase 2 — `/workshop`, a purpose-built page.** A third page beside `/` and
`/broadcast`, sharing the server, the `/events` endpoint and the one rule
everything else follows: *the viewer never writes anything*. Four panels:

- the room transcript, on the same clock as the tool calls
- **the game, live, in a sandboxed iframe**, pointed at the latest round snapshot
- a file tree with per-round churn bars and who touched what
- a round ribbon showing check status, so a red streak is visible at a glance

The iframe is the reason to build this page at all. Watching a canvas go from
black to a moving ship to a scored game over thirty rounds is a fundamentally
different artefact from watching a log, and it is the thing that will actually
get shown to people.

### The iframe is executing model-written code in your browser

Stated plainly because the commit immediately before this plan made the
broadcast viewer network-accessible. Rendering the artifact means running
JavaScript that five language models wrote, unreviewed, in a page that also
holds the run's data.

Non-negotiables for that panel:

- `sandbox="allow-scripts"` and **not** `allow-same-origin`. Together those two
  are equivalent to no sandbox at all.
- Serve snapshots from a dedicated path (`/artifact/<round>/…`) with
  `Content-Security-Policy: sandbox; default-src 'none'` and a strict
  `Content-Type`, never as part of the viewer's own origin's asset tree.
- The preview panel is **off by default** and behind an explicit toggle, and the
  toggle says what it does.
- When `watch` is bound to anything other than `127.0.0.1`, refuse to serve
  `/artifact/` at all unless a flag says otherwise. A broadcast on the LAN is a
  fun thing to share; a broadcast on the LAN that runs arbitrary generated code
  in every viewer's browser is not.

### The narrator

`narrate.ts` is structurally reusable — it reads the trace, writes a sidecar,
and can be killed at any moment with no effect on the run, which is the whole
design. Only its `SYSTEM` prompt and `digest()` are dungeon-shaped. Give the
simulation a `narratorBrief()` and a round digest built from its own snapshot,
and a build run gets commentary for about eighty lines of change. Phase 3.

## Reviewing it

The output of a run is a directory, and a directory is a worse deliverable than
it needs to be. `eval review --trace <file>` writes `review.html` into the
workshop directory:

- the artifact, embedded in a sandboxed iframe at the top, playable
- the round-by-round timeline: what each agent said and what changed on disk
- per-round diffs, collapsed
- the activity metrics table, under a heading that says *activity, not quality*
- cost, tokens, wall-clock, model, and the exact command that produced the run
- a review scaffold: five prompts for the human, with space to answer

That last item is the one worth arguing for. A qualitative eval with no
structure to the qualitative part decays into "seems fine" within three runs.
Five fixed questions — *does it run; is the core loop complete; is the code
coherent or five styles stapled together; did they finish what they agreed; what
did they never notice* — make two reviews six weeks apart comparable, which is
the only kind of comparability this eval can have.

## The control arm nobody will build unless it is in the plan

Same brief, same rounds, same budget, **one agent** with every tool and no
ownership partition.

Without it, every review of a five-agent run answers "is this good?" when the
question actually being asked is "did five agents beat one?". That is the latent
question behind the whole multi-agent framework, this is the first scenario in
the package that could answer it in a way anybody outside the project would find
legible, and it costs one extra scenario file and one extra run.

It is also the arm most likely to produce an uncomfortable result, which is a
reason to build it, not a reason not to.

## Build order

| phase | what | rough size |
|---|---|---|
| 1 | `review: true` in the schema; `score()`, `--min-score`, report block | ~150 lines, 2 tests |
| 1 | `sim/workshop/`: workspace, tools, ownership, snapshots, metrics | ~700 lines |
| 1 | `briefs.ts` with three briefs | ~150 lines |
| 1 | `scenarios/25-the-workshop.ts` + the solo control arm | ~250 lines |
| 1 | watch through the existing `/` viewer | 0 |
| 2 | `eval review` and `review.html` | ~400 lines |
| 3 | `/workshop` broadcast page with the live iframe | ~900 lines |
| 3 | narrator brief seam | ~80 lines |
| 4 | `playtest()` in a container: headless run, console errors, screenshot | a week |

Phase 1 is a day and produces a run you can review. Everything after it is
improving the review, not enabling it. Stop after phase 1 if the first run's
output is not interesting — that is the cheapest possible answer to "is this
worth building", and it is available before any of the expensive parts.

Before the first model call, do the descent's most valuable trick: **write a
scripted policy that plays the workshop.** A bot that creates four files, patches
them, and occasionally fails a check runs in milliseconds through the same tools
and writes the same trace. It will find the balance defects — a tool that
refuses everything, a snapshot that never fires, an announce line that leaks
another role's information — before any of them cost model time. Six scripted
parties found four defects in the descent that would each have been misread as an
agent failure.

## What it cannot tell you

- **Runs are not comparable with each other.** Two runs on the same brief differ
  by sampling, and there is no seed that fixes it because there is no world to
  seed. Every conclusion is a case study. Say "in this run" and never "the model
  does".
- **Model priors dominate.** A model that has read a thousand breakout clones
  will produce a competent breakout clone, and that says nothing about the
  framework. Prefer briefs with an unusual constraint in them for exactly this
  reason, and treat a suspiciously polished artifact as evidence of
  memorisation until shown otherwise.
- **A reviewer is not a stable instrument.** You will be more generous at 9pm
  than at 9am. The five fixed questions help; they do not fix it.
- **Syntax-clean is not working** until phase 4 exists.
- **It measures the framework only indirectly.** A bad artifact could be the
  model, the prompt, the tools, the history budget or the brief. The metrics
  narrow it — `patchesRefused` climbing means the agents lost track of the file,
  `roundsWithNoWrite` climbing means they are talking instead of building — but
  attribution is a judgement here, not a reading.

## Open questions

1. **Is a game the right first brief, or is it the most flattering one?** Games
   are the most memorised artifact class there is. A brief the model has never
   seen would be a harder and more honest first test, and a worse demo.
2. **Should the director be able to write code?** As specified they cannot,
   which is clean and possibly wastes the strongest agent in the room.
3. **Does the run get a definition of done, or only a horizon?** Forty rounds
   with no notion of finished means the team never has to converge. A brief that
   says "you have forty rounds; the last five are for fixing, not adding" is a
   different and probably better experiment.
4. **Where does the reviewer's verdict live?** Nowhere, in this plan. If reviews
   are worth keeping, they want a file in the workshop directory and a line in
   the history board — which is one step from a score, and should be resisted or
   embraced deliberately rather than by drift.

## Where the pieces would live

| what | where |
|---|---|
| the workspace, tools, ownership, snapshots | `packages/evals/src/sim/workshop/index.ts` |
| the briefs | `packages/evals/src/sim/workshop/briefs.ts` |
| syntax checking, no execution | `packages/evals/src/sim/workshop/check.ts` |
| the scripted development policy | `packages/evals/src/sim/workshop/policies.ts` |
| the scenario | `packages/evals/scenarios/25-the-workshop.ts` |
| the single-agent control | `packages/evals/scenarios/26-the-workshop-alone.ts` |
| `review: true` | `packages/evals/src/schema.ts`, `report.ts` |
| the review bundle | `packages/evals/src/review.ts` |
| the third page | `packages/evals/viewer/workshop/` |

```bash
# once phase 1 lands
pnpm run eval -- rehearse --simulation workshop --policy scripted   # no model, seconds
pnpm run eval -- run --filter the-workshop --rounds 40 --max-scenario-minutes 240
pnpm run eval -- watch                                              # /
pnpm run eval -- review --trace results/traces/<file>.ndjson        # phase 2
```
