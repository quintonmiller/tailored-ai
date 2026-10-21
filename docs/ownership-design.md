# Ownership and upkeep — Design

> Status: design, accepted 2026-10-20. Step 1 (archive and private recall) is
> in progress. Step 2 (`profile`, `commitment`, `doc` and `directory`) and
> step 3 (agent pages in the web UI) are built, off by default: see
> [the directory](./directory.md) and its [pages](./directory.md#pages). Builds on
> [world state](./world-state.md),
> [agent interfaces](./agent-interfaces.md),
> [dashboard widgets](./dashboard-widgets.md) and the places plugin's `tend`
> turn ([live sessions](./live-sessions.md#rooms-that-follow-the-work)).
> Replaces the timer-driven tick of the unbuilt
> [always-on agents](./always-on-agents.md) design.

## Goal

Each agent, and each room, owns things: its notes and memory, the work it has
taken on, what it has written up, and a page that shows all of it. It looks
after them in an upkeep turn that is told what changed, and other agents can
ask about them. The work an agent owns is the work it does without being asked.

## Why

### Proactive agents had nothing to do

An earlier always-on worker woke an agent on a timer and asked what it should
look at next. On one deployment it ran 2,332 times over twelve weeks:

| Outcome | Runs | Share |
|---|---|---|
| Errored | 1,121 | 48% |
| "ok" | 619 | 27% |
| Explicit no-op | 509 | 22% |
| Hit its token cap | 78 | 3% |

Most of the errors were the provider running out of credit, which is an
operations failure and not this design's concern. The rest is the design. The
"ok" runs mostly reported nothing new, or that every open task was waiting on a
person, and the same reminder came back tick after tick. Four causes:

1. **No work of its own.** "What should I look at next?" mostly finds nothing,
   and the model says so.
2. **Everything ended in a question for a person**, so initiative only made
   that person's queue longer.
3. **A clock, not a cause.** It woke whether or not anything had changed.
4. **No feedback.** It never learned whether what it raised was welcome, so it
   raised it again.

### Memory nobody owns rots

On the same deployment, byte-identical self-feedback notes grew to 215 rows,
48% of the note store, and crowded real notes out of recall. The nightly sweep
expires by age and keeps by recall count. Nothing notices that two notes say
the same thing, or that one contradicts another.

Recall isn't scoped either. Notes have an `agent` column, but the recall query
ignores it, so any agent with `recall` reads every agent's notes and narrates
them as its own. A new agent with no history once answered "Hey!" with a
callback to "last night", recalled from another agent's notes.

### Agents can't ask about each other

An agent has no good answer to four everyday questions about another agent:
what does it do, is it already working on something like this, has it written
up what I need, and how far along is it. The nearest thing today is reading the
other agent's notes, which is the leak above.

## The model

Every owned thing has an owner, people who may edit it, an audience, and
upkeep.

| | Owner | Can edit | Audience | Upkeep keeps it |
|---|---|---|---|---|
| An agent's private state | the agent | the agent | the agent (and people) | accurate, small, current |
| An agent's page | the agent | the agent | people, and other agents through `directory` | true to what the agent is for and doing |
| A room's state | the room's lead | the room's members | the members | decisions, open questions and commitments straight |
| A room's page | the room's lead | the room's members | people and visitors | the room's purpose and progress at a glance |

**Visibility** comes in three levels, mapped onto world-state scopes:

| Level | Who sees it | Scope |
|---|---|---|
| private | the owner | `agent:<name>` |
| room | the room's members | `room:<ref>` |
| shared | every agent | `global`, with an `owner` field |

People see every level through the UI and the API. Privacy between agents
keeps each agent's context about its own work, and keeps untrusted text (a web
page, an email) from spreading from one agent to the next through recall. It is
not a way to hide anything from the people running the deployment.

## Records

Three new world-state types, declared by a built-in plugin. Notes and memory
stay where they are.

### `profile`: what an agent is for

| Field | Holds |
|---|---|
| `purpose` | one or two sentences |
| `takesOn` | the kinds of work it accepts |
| `howToAsk` | hand it a commitment, post in a room, message it |

One per agent, shared. It starts from the agent's configured description and
the agent keeps it current.

### `commitment`: work an agent owns

| Field | Holds |
|---|---|
| `goal` | what it's for, in one line |
| `doneWhen` | how anyone can tell it's finished |
| `status` | `open`, `waiting`, `done` or `dropped` |
| `nextStep` | the next thing the owner will do |
| `nextCheck` | a time, or an event to watch for |
| `autonomy` | `suggest`, `tell` or `quiet` (see [proactive work](#how-this-carries-proactive-work)) |
| `progress` | `{ value, max }`, or a step label |
| `updates` | dated one-line entries, newest first |
| `from` | who handed it over: a person, an agent, a room |

Shared by default, so others can see progress; private when marked. A
commitment comes from the owner proposing it, a person ("keep an eye on hotel
prices for Lisbon"), another agent handing it over, or a room's lead.

### `doc`: what an agent has written up

| Field | Holds |
|---|---|
| `title`, `summary`, `body` | the write-up |
| `tags` | for search |
| `reviewedAt` | when the owner last checked it was still true |

Shared. How a pipeline works, a person's preferences, a checklist: things the
owner keeps current so nobody has to work them out again.

### Notes and memory

The existing stores, private to the agent: scratch space, not something to
publish. When a note turns out to matter to others, upkeep promotes it into a
doc on purpose.

A room keeps the same three types in its own scope, owned by its lead.

## Asking about another agent

One tool, `directory`:

```
directory(about: "trip-planner")
→ Trip planner. Takes on: trip research, itineraries, bookings with approval.
  Working on: "Lisbon, Nov 12–16": 3 hotels shortlisted, waiting on owner since Tue.
  Docs: "Travel preferences" (reviewed Oct 18), "Booking checklist".
  To ask: hand it a commitment, or post in #travel.

directory(search: "hotel prices in Lisbon")
→ commitment trip-planner/lisbon-nov: open, 60%, last update 2 days ago
  doc trip-planner/travel-preferences: "Travel preferences"
```

- `about` returns the profile, open commitments and doc titles.
- `search` runs one semantic search over shared commitments and docs, plus the
  room records the asker can see, with status and freshness on every hit.

Two things happen without anyone asking:

- **Similar work on create.** Creating a commitment or a doc returns the
  closest shared matches from other agents ("trip-planner already has 'Lisbon
  trip prep' open"). It informs and never blocks. It costs an embedding lookup,
  not a model call.
- **Misses are signals.** A search that finds nothing is recorded against the
  agent whose `takesOn` matches it best. That agent's next upkeep turn sees
  "two agents looked for how renders are queued and found nothing", which is a
  reason to write the doc.

Agents don't read pages. A page is HTML for people. `directory` reads the
records the page is drawn from, so the two can't disagree.

## Pages

Every agent and every room has a page in the web UI. A page is a layout spec:
a list of sections, each a widget bound to records or a query, plus a short
note in the owner's own words.

An agent's default page:

- what I'm for (the profile)
- working on (open commitments, with progress)
- waiting on you
- recent results (finished commitments, docs other agents read)
- what I take on and how to ask
- docs

The owner rearranges, hides and adds sections. Starting from a working default
matters on a small model: adjusting a page is a much easier task than
designing one.

- **Numbers come from bindings.** The owner chooses what to show and in what
  order, and never types a figure. Achievements are records too: commitments
  finished, initiatives a person acted on, docs other agents read.
- **One widget vocabulary.** Page widgets are interface kinds (cards, lists,
  tables, progress, and kinds plugins add). Board widgets and the 3D world's
  wall widgets move onto the same kinds, so an agent learns one set.
- **The same page on a wall.** An agent's page hangs in its home in the 3D
  world, and a room's page in its meeting room.

## Upkeep

The places plugin's `tend` turn already gives an agent, on an interval, an
account of what it did and an invitation to change its 3D room, and skips
agents that did nothing. Upkeep widens that turn to everything the agent owns.

The upkeep message carries evidence, counted rather than asked for:

- notes not recalled in a while, near-duplicate pairs, and notes a newer note
  or doc contradicts
- commitments past due, waiting too long, or with no update in a while
- docs not reviewed in a while, docs other agents read, and directory misses
  in its area
- what people corrected or waved away
- the size of its pinned context against its budget
- the page sections people opened

And it runs under rules:

- **Skipped when nothing changed.**
- **A budget of edits per turn.**
- **Every change logged**, with the log shown on the page.
- **Retiring means archiving** ([below](#archive)), so upkeep acts and
  reports instead of asking.
- **What it can't settle alone becomes a question for a person**, with a
  default that applies if nobody answers.

Upkeep runs on the interval and on events: a watcher fired, a commitment's
`nextCheck` came due, a person edited something the agent owns.

A size budget is the goal that keeps upkeep from being busywork. "Keep your
pinned memory under 1,500 tokens" gives tidying a target, and the result is a
smaller prompt on every turn.

## Rooms

- **A room has a lead agent:** named in config, otherwise the agent that
  created the room. A person can reassign it.
- **Members edit.** Agents and people in the room add and change its records,
  and every change records who made it.
- **A person's edit sticks.** The lead changes it only by asking.
- **A person's request to the lead becomes a commitment for the lead**, such as
  "add a budget section" or "summarise last week".
- **The lead gets the room's upkeep turn.**

## Widgets an agent makes

Three levels:

1. **Configure** an existing widget's options and bindings.
2. **Compose** a new widget from existing kinds and bindings, saved as a
   `widget` record that other pages can reuse. It's data, so an agent does it
   alone.
3. **Code** a new kind, in one of two ways:
   - a request: a commitment handed to a builder agent, which ships a plugin
     kind through the normal review path;
   - HTML in a sandboxed frame with no same-origin access and no network. Data
     goes in, nothing comes back out.

A sandboxed widget that gets used turns into a request for a real kind.
Widgets used on many pages become defaults.

## Archive

One `archived` state for notes (and the search chunks made from them), facts
and world-state records. It follows the convention rooms already use:
`archived_at`, `archived_by` and `archive_reason`, an `includeArchived`
option, and `archive` and `unarchive` verbs.

- It's left out by default of everything that loads context or searches:
  prompt layers, pinned state, `recall`, semantic search, `facts`, `state`
  queries, `directory`, pages and HTTP lists.
- `includeArchived: true` on a query, search or list brings it back. Fetching
  one item by id still works and says that it's archived.
- `unarchive` restores it. Setting an archived fact's key again restores it
  with the new value.
- What agents remove, they archive: `recall forget` and `facts forget` become
  reversible. A person's delete stays a delete.
- The nightly memory sweep archives expired notes instead of deleting them.
- Archiving a world-state record is an `update` in `state.changed`, so
  existing consumers keep working. A store that can't archive refuses, rather
  than reporting success and leaving the record live.
- Live state a plugin owns (who is where, who is talking to whom) is still
  deleted when it ends. Archiving is for things worth keeping.

`recall action="archive"` used to mean "keep this note forever", and nothing
read the flag it set, so a kept note was swept like any other. It now hides a
note, which is what people already expected it to do. `keep` takes the old
meaning, and the sweep honours it.

Core memory and the markdown memory files are left out for now. Core memory
is small, always loaded and edited in place; the files have no lifecycle to
speak of.

Nothing in this design hard-deletes. Deleting stays a person's action.

## Private recall

- `recall` returns the calling agent's own notes, plus notes no agent owns
  (a person's notes, and older session summaries). Prompt injection already
  works this way; the `recall` tool didn't.
- Semantic search follows the source note's owner, so promoting a note into
  the search index doesn't make it public.
- A session summary belongs to the agent whose session it summarises.
- A session with no named agent keeps seeing everything, as it does today.
- Facts stay shared. They're about the world and the people in it, not one
  agent's work.
- Sharing is deliberate: an agent writes a doc. Nothing leaks through recall.

This changes behaviour for any deployment whose agents read each other's
notes, and the release notes say so.

## How this carries proactive work

```
work (commitments, watchers) → owned records → upkeep → page → people react → next upkeep
```

- **Commitments** are the agent's own work, which the old tick lacked.
- **Watchers** are cheap checks with no model call (a price moved, a page
  changed, an email arrived from someone). They wake an agent only when
  something changed, with the change attached. World-state subscriptions and
  schedules are the existing pieces.
- **Autonomy** on a commitment: `suggest` asks first; `tell` acts on anything
  reversible and reports afterwards, with an undo; `quiet` acts and logs.
  Irreversible steps always ask. After a person approves the same kind of
  step a few times, the agent may ask to move it to `tell`; it never grants
  itself more.
- **One daily batch of questions** gathers what every agent needs from a
  person, each question with buttons and a default that applies if nobody
  answers, so silence stops blocking work.
- **Prepare, don't act.** Drafts, briefs and pulled-together confirmations
  show up on the agent's page before they're needed, with nothing sent.
- **Reactions.** Every unprompted message or card takes a one-tap reaction:
  useful, not now, or stop this kind. Ignored for two days counts as a mild
  no, and upkeep sees the tally. Initiatives acted on per week is the measure
  of whether any of this works.
- **Handoffs.** Agents find each other through `directory` and hand over
  commitments.

## Where it lives

- **Core** (platform contract): the archived state, honoured by every store
  and every reader; recall scoped by owner; semantic search over world-state
  records using the existing embedding registry.
- **Built-in plugins:** the record types, `directory`, pages, upkeep (grown
  from `tend`), room leads, widget records, watchers.
- **Deployment config:** which agents take part, upkeep intervals, budgets,
  and who leads which room.

## Build order

1. **Archive and private recall** (core). Everything after depends on these
   being right.
2. **`profile`, `commitment`, `doc` and `directory`**, with the similar-work
   check and misses.
3. **Agent pages** from bound widgets, on the one widget vocabulary.
4. **Upkeep**, covering notes, commitments, docs and the page.
5. **Rooms with leads.**
6. **Composed widgets.** Sandboxed code widgets later.
7. **The proactive pieces:** watchers, autonomy levels, the daily batch and
   reactions.

Then a week on three agents and one room, measuring pinned context size,
duplicate notes, stale commitments, directory answers that saved repeated
work, page opens, and initiatives acted on.

## Risks

- **Busywork.** Upkeep without evidence rewrites things to look busy. The
  evidence-driven message, the skip when idle and the edit budget are the
  guards, and the reverted-edit rate is the tell.
- **Vanity.** An agent can polish its page instead of working. Bound numbers
  and achievements taken from records keep it honest.
- **Cost.** Dozens of agents doing upkeep is real spend. Start with a few, and
  run upkeep only when something changed.
- **Losing something.** Archive only, and everything restores.
- **An injection path.** Shared records carry text from emails and the web,
  and other agents read them. `directory` hands results to the asker as data
  marked with their owner, never as instructions.
- **Edit wars in rooms.** The lead decides, a person's edits stick, and the
  change log shows who did what.

## Open questions

- Do commitments replace project tasks for work an agent owns, or sit beside
  them? Tasks have assignees, autopilot and backends; commitments have
  autonomy, checks and updates.
- Do `facts` (no owner column today) become shared records, or stay as they
  are?
- Where does the daily batch reach a person: a Discord DM, the Home page, or
  both?
- How long is the undo window for `tell`?
