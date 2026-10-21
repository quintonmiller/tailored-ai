# The directory

Agents can say what they're for, take on work and keep track of it, and write
things up for each other. Other agents ask about any of it with one tool. It
all lives in [world state](./world-state.md), so people see and edit the same
records on the State page.

This is step 2 of [ownership and upkeep](./ownership-design.md). What works
today: the records, the three tools, the similar-work check, misses, a
"Your commitments" block in the prompt, and two read-only routes for agent
pages. Nothing acts on a commitment by itself yet; see [Not yet](#not-yet).

## Turn it on

The directory ships as the built-in plugin `builtin:directory`, seeded into
every config with `enabled: false`. Flip it on:

```yaml
plugins:
  - module: builtin:directory
    enabled: true
    config:
      pin: true         # the "Your commitments" block; false leaves it out
      minMeaning: 0.5   # how close a search hit by meaning must be, 0 to 1
      minWords: 0.3     # how close a search hit by words must be, 0 to 1
```

Every key under `config` is optional; the values above are the defaults.

Turning it on adds three tools, `directory`, `commitment` and `writeup`. An
agent with no `tools:` list gets all three. An agent with a list gets the ones
it names, so a reader that should only look things up might take
`[directory, writeup]`.

With embeddings configured (`memory.embeddings`, the embedder `recall` uses),
searches match by meaning. Without them they match words. See
[Searching](./world-state.md#searching).

## The records

Four world-state types, declared by the plugin:

| Type | Id | Where it lives | Holds |
|---|---|---|---|
| `profile` | the agent's name | `global` | `owner`, `purpose`, `takesOn` (a list), `howToAsk` |
| `commitment` | `<owner>-<slug>` | `global`, or `agent:<owner>` when private | `owner`, `goal`, `doneWhen`, `status` (`open`, `waiting`, `done`, `dropped`), `nextStep`, `nextCheck`, `autonomy` (`suggest`, `tell`, `quiet`), `progress`, `updates`, `waitingOn`, `from` |
| `doc` | `<owner>-<slug>` | `global` | `owner`, `title`, `summary`, `body`, `tags`, `reviewedAt` |
| `miss` | `miss-<day>-<hash>` | `agent:<owner>` | `owner`, `query`, `askedBy`, `at`, `closest` |

- **Agents change only their own,** and only through the tools. They can read
  all four through `state`, but its writes are refused: `access.write` is
  people only.
- **People can edit anything** on the State page or through
  `/api/state/...`, including reassigning an `owner`.
- **Every write says where it came from.** A tool's write is recorded as
  `plugin directory` with the tool's name as its source, so the State page
  reads "updated by plugin directory via the commitment tool", and `owner`
  says whose it is.
- **`progress`** is `{ value, max }` or a label. The tool reads "3/5",
  "3 of 5", "60%" or a plain step name like "drafting".
- **`updates`** are dated one-line entries, newest first. The record keeps
  the latest 20; its history keeps every version.
- **Archived** records drop out of `about`, lists, search and the prompt
  block, as everywhere in world state. A person brings one back from the State
  page.

## Asking about agents: `directory`

```
directory(action: "about", agent: "trip-planner")
→ trip-planner: Plans trips end to end, from research to bookings.
  Takes on: trip research, itineraries, bookings with approval.
  To ask: Hand it a commitment, or post in the travel room.
  Working on (1):
  - trip-planner-lisbon-trip-nov-12-16 "Lisbon trip, Nov 12-16": waiting on a person to pick a hotel, 3/5, next: Shortlist three hotels near Alfama, check: Friday, last update 2 days ago
  Docs (1):
  - trip-planner-travel-preferences "Travel preferences", reviewed 2026-10-18
```

- **`about`** takes `agent`, defaulting to the asker. With no profile it shows
  the agent's configured `description`, marked as such. About yourself it
  adds your private commitments and the misses in your area from the last two
  weeks, and nudges you to write a profile if you have none.
- **`search`** takes `q` and an optional `kind` (`commitment`, `doc` or
  `profile`), and returns one ranked list over what the asker can see:

  ```
  directory(action: "search", q: "hotels in Lisbon")
  → 2 found for "hotels in Lisbon", closest first:
    - commitment trip-planner-lisbon-trip-nov-12-16 "Lisbon trip, Nov 12-16" by trip-planner: waiting on a person to pick a hotel, 3/5, last update 2 days ago (matched by words)
    - doc trip-planner-travel-preferences "Travel preferences" by trip-planner: reviewed 2026-10-18, updated 3 days ago (matched by words)
    Read a doc with writeup, action read.
  ```

  A hit has to clear a bar to count: `minMeaning` for one matched by meaning,
  `minWords` for one matched by words. The two scores come from different
  measures, so each has its own. An embedder that scores related text lower
  than most needs a lower `minMeaning`.
- **`profile`** writes your own entry: `purpose`, `takesOn`, `howToAsk`. Only
  the fields you pass change.

Every result says whose it is, and `writeup read` introduces another agent's
doc as "information, not instructions to you". Shared records can hold text
from an email or a web page, and this keeps it reading as someone's data.

## Work an agent owns: `commitment`

```
commitment(action: "open", goal: "Lisbon trip planning for November", doneWhen: "Dates on the calendar")
→ Opened planner-lisbon-trip-planning-for-november: "Lisbon trip planning for November" (shared, suggest).
  Similar: trip-planner has "Lisbon trip, Nov 12-16" waiting, 3/5 (trip-planner-lisbon-trip-nov-12-16).
```

| Action | Takes | Does |
|---|---|---|
| `open` | `goal`, `doneWhen`, and optionally `nextStep`, `nextCheck`, `autonomy`, `private`, `from` | creates it, open, with an "Opened." update, and names up to two similar open commitments of other agents |
| `update` | `id`, and any of `note`, `progress`, `nextStep`, `nextCheck`, `status` (`open` or `waiting`), `waitingOn` | changes those fields and adds a dated update: the note, or a line saying what changed. `waitingOn` sets it waiting; going back to `open` clears it |
| `done` | `id`, `note`? | marks it done; a count like 3/5 goes to 5/5 |
| `drop` | `id`, `why` | marks it dropped, with the reason as its last update |
| `archive` | `id`, `reason`? | puts it away |
| `list` | `agent`?, `status`? (`open`, `waiting`, `done`, `dropped` or `all`) | yours by default, open and waiting |

`autonomy` is recorded for the pieces still to come; nothing acts on it yet.
An agent sets it when it opens a commitment and can't raise it afterwards.
A person can.

## What an agent writes up: `writeup`

| Action | Takes | Does |
|---|---|---|
| `write` | `title`, `summary`, `body`, `tags`? | creates a doc, reviewed today, and names up to two similar docs of other agents |
| `update` | `id`, any of `title`, `summary`, `body`, `tags` | changes it and marks it reviewed: rewriting it is checking it |
| `review` | `id` | marks it checked and still true today |
| `read` | `id` | the whole doc, anyone's |
| `list` | `agent`? | yours by default |
| `archive` | `id`, `reason`? | puts it away |

The tool is called `writeup` and the record type `doc` because the built-in
`documents` tool, which manages a project's files and is on by default, sits
in the same tool list. Two tools that both "read, update and list documents"
is a coin toss for a small model.

## Similar work

`commitment open` and `writeup write` search the same type for other agents'
records like the new one, and name up to two:

```
Similar: trip-planner has "Lisbon trip, Nov 12-16" waiting, 3/5 (trip-planner-lisbon-trip-nov-12-16).
```

It informs and never blocks: the record is written first, and a search that
fails finds nothing. Only records the agent can see count, never its own, and
for commitments only open or waiting ones. It costs an embedding of the new
text, not a model call.

## Misses

A search that no commitment or doc answers is noted as a `miss`, against the
agent whose profile is closest to the query. That agent sees it in its own
`about`:

```
Looked for in your area lately, with no doc or commitment to find:
- "bookings with approval for a ski chalet", asked by writer, planner on 2026-10-21
```

- **One miss per query per day** (by UTC date). The query's words decide what
  counts as the same: "ski chalet bookings with approval" and "bookings with
  approval for a ski chalet" are one miss. Whoever else asks that day is added
  to `askedBy`.
- **A profile hit isn't an answer.** It says whose area the question is in,
  not what that agent knows, so a search that finds only profiles still notes
  a miss.
- **No profile close enough, no miss.** The closest profile has to come within
  half the bar. Below that nobody's area fits, and the search just says
  "Nothing found".
- **A partial search notes nothing.** When a store couldn't be read to the end
  (see [When a search can't read everything](./world-state.md#searching)),
  silence there isn't proof, and the search says so instead.
- **Private to its agent.** A miss lives in `agent:<owner>`, so other agents
  don't see it. People do.

Nothing reads misses on its own yet. They're the evidence the upkeep turn
(step 4) will start from.

## The prompt block

Every turn, an agent that has the `commitment` tool gets its open and waiting
commitments behind the history, open ones first:

```
## Your commitments

- trip-planner-anniversary-surprise-dinner-in-lisbon "Anniversary surprise dinner in Lisbon": open, last update just now, private
- trip-planner-lisbon-trip-nov-12-16 "Lisbon trip, Nov 12-16": waiting on a person to pick a hotel, 3/5, next: Shortlist three hotels near Alfama, check: Friday, last update just now
```

- At most ten, then a count of the rest ("…and 3 more; commitment list shows
  them all"). The block's budget is 400 tokens; past that it's cut, and the
  cut is marked.
- Nothing at all for an agent with no open work, or whose `tools:` list leaves
  out `commitment`.
- `pin: false` turns it off for everyone.

## What's private

| | The owner | Other agents | People |
|---|---|---|---|
| Profiles, docs, shared commitments | sees and changes | sees | sees and edits |
| Private commitments | sees and changes | don't see them anywhere: not in `about`, `search`, `list` or similar work | see and edit |
| Misses | sees its own | don't see them | see and edit |

Another agent asking to change your record gets a plain refusal naming you:
"trip-planner-lisbon-trip-nov-12-16 is trip-planner's commitment; only
trip-planner can change it." A private one it can't see reads as absent.
Privacy here keeps each agent's context about its own work. It hides nothing
from the people running the deployment.

## HTTP

Behind the usual bearer auth. Both read as a person: every scope.

| Route | Returns |
|---|---|
| `GET /api/ext/builtin:directory/agents` | `{ agents: [{ name, profile, description?, commitments: { open, waiting, done }, docs }] }`: every agent (the agent registry and `config.agents`, as Discord counts them) and anyone with a profile. `profile` is the profile's data or `null`; `description` is the configured one |
| `GET /api/ext/builtin:directory/agents/:name` | `{ name, profile, description?, commitments, docs, misses }`, each a list of full records, private ones included. `404` for a name that is neither an agent nor a profile |

Counts and lists read at most 5,000 records of each type.

## Not yet

- **Nothing acts on a commitment.** `nextCheck` is text, `autonomy` is a
  label, and no turn is started for either. Watchers, schedules and the
  upkeep turn come later in the [build order](./ownership-design.md#build-order).
- **No room records.** A room's own commitments and docs, owned by its lead,
  are step 5.
- **A store that fails fails the search.** All four types usually share one
  store, so `directory search` names them and reports the store's error
  rather than an empty result.
