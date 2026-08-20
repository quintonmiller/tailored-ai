# Open builds — a scenario with a brief instead of a score

**Phase 1 is built, green, and has been run against a live model.** Three
scenarios, a `workshop` simulation, a `review:` schema flag, a scripted
rehearsal, and 47 tests. The first run found three faults and produced an
artifact worth opening — see *What the first live run found*. The later phases
at the bottom are still a plan.

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

### Two things to watch rather than fix

- **Read amplification.** `read_file` was 47 of 139 calls, and the smoke spent
  1.6M input tokens against 57K output. Prefix caching absorbs much of it, but
  the team's default move is to re-read a whole file rather than navigate it.
- **`outline_file` is nearly unused** — zero calls in the smoke, one in the
  first rounds of the long run. It exists precisely for the file that has grown
  too big to read, and the team has not yet reached for it.

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
3. **Twenty rounds with no definition of done means the team never has to
   converge.** The opening message says to leave the last few rounds for fixing
   rather than adding; whether that is enough is a thing to read off run one.
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
| tools, roles, metrics, `briefFor` | `packages/evals/src/sim/workshop/index.ts` |
| the scripted bot | `packages/evals/src/sim/workshop/policies.ts` |
| the three scenarios | `packages/evals/scenarios/25-the-workshop.ts` |
| a trace without a model | `packages/evals/scripts/workshop-rehearse.ts` |
| `review:` and its rules | `packages/evals/src/schema.ts`, `report.ts` |
| tests | `packages/evals/src/__tests__/workshop.test.ts` |
