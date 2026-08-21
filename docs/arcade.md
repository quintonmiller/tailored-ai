# The arcade

A local site that hosts what the game jam builds, and the scores a person gives
it. `packages/arcade/` — a private package with **no dependency on TAI**, which
is the point: it is not a framework feature, it is a thing the benchmark writes
to.

```bash
pnpm run arcade                     # site on :4321, games on :4322
pnpm run jam:loop                   # run jams until stopped; each one adds a game
pnpm run arcade:import <dir>        # pull in artifact directories from before this existed
```

## What it is for

`docs/open-builds.md` describes an eval with **a brief instead of a score**:
five agents build a real artifact over twenty rounds and a person opens it. That
works for one run and stops working at ten. A folder of markdown scorecards
cannot answer *did theme relevance improve over thirty jams*, *is this model
reliably worse at polish than at gameplay*, or *did the team that read previous
entries do better* — those are queries, and the answer to all of them is a
database.

It also closes the loop the other way. The agents can read the arcade during a
run, so a team can see what scored well before it decides what to build. Whether
that changes anything is an open question with a counter attached
(`arcadeBrowses`, `arcadeReads`) rather than an assumption.

## What is on a page

Everything the run knew plus everything the team wrote.

| | |
|---|---|
| **The team writes** | title, one-line pitch, genre, description, how to play |
| **The run records** | theme, brief, rounds, seed, model, provider, endpoint, context window, reasoning effort, temperature, max tokens, tool rounds, TAI version, simulation version, commit, role→agent credits |
| **The site adds** | screenshots, a build reel, a playable copy, a `.zip`, the activity counters, and the reviews |

The provenance half is not writable by an agent. See *Scoping*, below.

## Five categories

| key | name | the question |
|---|---|---|
| `theme` | Theme relevance | Does the theme shape the mechanics, or is it decoration? |
| `gameplay` | Gameplay | Is the core loop actually enjoyable for a minute? |
| `visuals` | Visuals | Does it look considered, given that everything is drawn from shapes? |
| `originality` | Originality | Is there an idea here you have not seen before? |
| `polish` | Polish | Does it feel finished and run clean — every state resolves, no console errors, no dead ends? |

Scored 1–5, each with a written anchor at both ends so the scale means the same
thing twice. They live in `packages/arcade/src/categories.ts` and **that is the
only copy** — the brief the agents are judged against, the scorecard left in the
artifact directory, and the site's review form all read it. Three hand-maintained
lists would drift within a week, and the failure mode is the worst available:
agents told they are judged on one thing, scored on another.

There were six. `polish` and `technical soundness` were never independent —
the same cause produces both (nobody played it), and a judge asked to separate
"feels finished" from "runs clean" writes the same sentence twice.

**Overall is the mean of the category means, not the mean of every score handed
in.** The difference bites as soon as two people review the same game and one
skips a category: averaging all the numbers would let a reviewer who filled in
only `visuals` drag the overall towards visuals. Categories nobody scored are
left out rather than counted as zero, and a game nobody has judged sorts *last*
rather than beneath the ones with a 1.0.

## Reviewing

Type a name into **reviewing as** and score. It comes back next time you open
the page, and a second review from the same name replaces the first — a change
of mind is a correction, not a second data point.

**This is not authentication.** The name is a label kept in `localStorage`;
anyone who can reach the port can review as anyone. That is the right amount of
security for a thing bound to loopback on one machine, and it is written in the
page footer so nobody later mistakes it for a login.

## The agents' side

Four tools, handed out during a jam:

| tool | |
|---|---|
| `arcade_browse` | previous entries, sorted by overall or by any category, with their scores |
| `arcade_read` | one entry in full, including what the judge wrote |
| `arcade_entry` | your own page, and **what is still missing from it** |
| `arcade_register` | write your own page. Partial updates; call it again to change anything |

`arcade_entry` naming the *absent* fields is the load-bearing half. A team
reading back what it already wrote learns nothing; a team told "instructions:
empty — a judge will not know which keys do anything" has a next action.

### Scoping is structural, not checked

`arcade_register` **has no parameter for which entry**. It closes over the one
id the run owns, and `ArcadeStore.register` can only reach five columns. There is
no argument an agent could pass to edit another team's row, or to claim a
different model built its game. A check would have to be got right every time it
was copied; there is nothing here to copy.

Who may call it follows file ownership: whoever owns `submission.md` — they are
the same document written twice, and splitting them across two agents is how a
game ends up pitched two different ways. In the solo arm there is one agent and
the gate is off.

### It talks to the database, not to a server

Deliberately. A benchmark run that needs a web server up is a run that fails for
reasons belonging to neither the model nor the simulation, and diagnosing "the
team never registered" as a dead port is exactly the kind of afternoon this
package keeps having. SQLite is a file; the site and the run open the same one.

## Two ports, and why

The games are written by a language model and then executed in the reviewer's
browser. That is the whole point of the site and also the only adversarial thing
in it. Served from the same origin as the API, a game could `fetch` its own
review endpoint and give itself fives — not because a model would, but because
nothing would stop it, and **a review database writable by its own subjects is
worth nothing**.

So games get their own port: same host, different origin, no CORS headers on the
API, and the browser refuses the request. Game files are additionally served with
`connect-src 'none'`, so a game cannot make a network request at all.

The alternative — `<iframe sandbox="allow-scripts">` without
`allow-same-origin` — also works and costs more: it puts the game in an opaque
origin where `localStorage` throws, so a game that saves a high score would crash
on load through no fault of its own.

Both servers bind to loopback. There is no authentication anywhere in this.

## Screenshots, and the reel

A twenty-round run calls `playtest` up to sixty times and leaves a few hundred
PNGs. All of them is a gigabyte across a hundred games and nobody looks at the
middle four hundred. Two selections earn their space:

- **shots** — every frame from the *last* playtest: the finished game as it ran.
- **reel** — one frame per playtest round, evenly sampled to twelve. Played in
  sequence this is the closest thing to a video of the build, and it is the only
  view in this package that shows a game getting *worse* between round nine and
  round fourteen.

There is no video encoding and nothing produces a video file; the schema has a
`kind` for one if that ever changes.

## Where the data lives

`~/.tai-arcade` by default, or `$ARCADE_HOME`. **Outside the repo on purpose** —
`results/workshops/` lives in a git worktree, worktrees get deleted, and the
whole value of this thing accrues over months. Publishing copies the workspace
in; the original path stays on the row as provenance that is allowed to rot.

```
~/.tai-arcade/
  arcade.db
  games/<run-id>/
    files/        the playable copy
    shots/        screenshots and reel frames
    <slug>.zip    the download
    brief.md  manifest.json  JUDGING.md
```

## Importing older runs

```bash
pnpm run arcade:import ~/…/packages/evals/results/workshops --model qwen3.8-27b --min-rounds 10
```

Import always skips a directory whose manifest lists **no files**. The workshop
writes its artifact directory in its constructor — deliberately, so a run that
dies half-way still leaves a reviewer the brief and the questions — and the cost
is that a run which never took a turn leaves a complete-looking directory behind.
Twenty-four of the first twenty-seven directories on this machine were that, and
`rounds` cannot tell them apart because it is the horizon the run was
*configured* for: an abandoned 220-round arm reads as the longest run on the
board.

An imported run has no registration and is left that way, flagged **never
registered** on its card. Filling the title in from the brief looked helpful for
one run and was actively misleading across twenty-seven, because every entry then
read "A small arcade game that runs in a browser".

## Running the jam on a loop

```bash
pnpm run jam:loop                          # forever, seeds counting up
pnpm run jam:loop -- --runs 5              # five and stop
pnpm run jam:loop -- --seed 40 --brief site
pnpm run jam:loop -- --arm the-workshop-alone
```

Each run gets its own seed, **which is what picks the theme** — a loop on one
seed is eight hours of the same jam. The script waits for the endpoint rather
than running against a dead one: a run against a down port finishes in three
minutes with zero tool calls and no error at all, which looks exactly like a
model that did nothing.

A jam is about ninety minutes at 220 turns on the local model.

## Turning it off

The arcade opens only when the simulation is given a `run` context (which the
harness supplies and `bench`, `rehearse` and unit tests do not) **or** an
explicit `arcadeHome`. `--sim-option arcade=off` disables it entirely, brief text
included, so a control arm run without it does not differ by a stray heading.

That gate is not a nicety. The first version defaulted to on and lasted one test
run: the suite constructs the workshop forty-eight times, and forty-eight rows
landed in the real database, several of them published. A convention that tests
must remember to pass a temporary home is not a guard.

## What this cannot tell you

- **The scores are one person's.** Five categories with written anchors make two
  reviews weeks apart comparable; they do not make them objective, and there is
  no second judge.
- **Reviewing is unblinded.** The model, the theme and the counters are on the
  page you score from. If that turns out to matter, the fix is a review mode
  that hides provenance until a score is submitted — nothing here does that yet.
- **Registration is a confound.** Teams that can read previous entries are
  playing a different game from those that could not, so the imported backlog and
  everything after it are not one series. `arcadeBrowses` says who actually
  looked.
- **A published entry is not a finished game.** Publishing happens when the
  rounds run out, not when the thing works. `playtestErrors` and
  `lastCheckProblems` are on the page for that reason.
