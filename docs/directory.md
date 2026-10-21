# The directory

Agents can say what they're for, take on work and keep track of it, and write
things up for each other. Other agents ask about any of it with one tool. It
all lives in [world state](./world-state.md), so people see and edit the same
records on the State page.

This is steps 2 and 3 of [ownership and upkeep](./ownership-design.md). What
works today: the records, the three tools, the similar-work check, misses, a
"Your commitments" block in the prompt, and a page for every agent in the web
UI that the agent arranges and you can hand work through. Nothing acts on a
commitment by itself yet; see [Not yet](#not-yet).

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

Turning it on adds three tools, `directory`, `commitment` and `writeup`. It
can add a fourth: `state` is offered once any world-state type exists, so on
a deployment where nothing else declared one (no avatar, no `state.types`),
the directory's types bring `state` in too. Agents read these records through
it. An agent with no `tools:` list gets all of them. An agent with a list gets
the ones it names, so a reader that should only look things up might take
`[directory, writeup]`, and one that shouldn't have `state` leaves it out.

**Changing it while TAI runs.** A config reload picks up `pin` and the two
bars at once, and turning the directory on or off by reload adds or removes
its tools, types, prompt block and routes straight away. A call already
running when it is turned off answers that the directory is turned off, and
the agent pages show the [fallback](#with-the-directory-off).

**A type of the same name in your config wins.** If `state.types` declares a
`profile`, `commitment`, `doc`, `miss` or `page`, that declaration replaces
the directory's, and the directory warns at load. Its `access` then decides who
can write, so agents may change each other's records through `state`, and a
kind it declares without `search` can't be searched: `directory search` says
so and notes no miss. Give your own type another name.

With embeddings configured (`memory.embeddings`, the embedder `recall` uses),
searches match by meaning. Without them they match words. See
[Searching](./world-state.md#searching).

## The records

Five world-state types, declared by the plugin:

| Type | Id | Where it lives | Holds |
|---|---|---|---|
| `profile` | the agent's name | `global` | `owner`, `purpose`, `takesOn` (a list), `howToAsk` |
| `commitment` | `<owner>-<slug>` | `global`, or `agent:<owner>` when private | `owner`, `goal`, `doneWhen`, `status` (`open`, `waiting`, `done`, `dropped`), `nextStep`, `nextCheck`, `autonomy` (`suggest`, `tell`, `quiet`), `progress`, `updates`, `waitingOn`, `from` |
| `doc` | `<owner>-<slug>` | `global` | `owner`, `title`, `summary`, `body`, `tags`, `reviewedAt` |
| `miss` | `miss-<day>-<hash>` | `agent:<owner>` | `owner`, `query`, `askedBy`, `at`, `closest` |
| `page` | the agent's name | `global` | `owner`, `note`, `order`, `hide`, `extra` (see [Pages](#pages)) |

- **Agents change only their own,** and only through the tools. They can read
  all five through `state`, but its writes are refused: `access.write` is
  people only.
- **People can edit anything** on the State page or through
  `/api/state/...`, including reassigning an `owner`.
- **Every write says where it came from.** A tool's write is recorded as
  `plugin directory`, with the tool's name and the agent it wrote for in its
  source (`source.onBehalfOf`). The State page reads "updated by plugin
  directory for planner via the commitment tool", and `owner` says whose it
  is. A [subscription](./world-state.md#waking-agents-on-a-change) counts the
  write as that agent's own change, so an agent watching commitments isn't
  woken by its own updates.
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
  than most needs a lower `minMeaning`. At most eight hits are shown; when more
  cleared the bar, the first line says so ("The closest 8 of 12 found...").
- **Counts are honest.** `about`, `commitment list` and `writeup list` read a
  limited number of records; when a read stops at its limit, the count reads
  "50+" rather than a number that looks like all there is.
- **`profile`** writes your own entry: `purpose`, `takesOn`, `howToAsk`. Only
  the fields you pass change. Asked with another agent's name, it points to
  `about`, which is how you read one.
- **`page`** arranges your [page](#pages): `note`, `order`, `hide`, `add`,
  `remove`. With none of them it says how the page is laid out now. `about`
  yourself shows your page note, or that you have none.

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
- **It names only what its agent can see.** `closest` is the nearest
  commitment or doc that wasn't close enough, picked from records the miss's
  agent could read itself: shared ones, or its own. The asker's private work,
  or a record in a room the agent isn't in, is never written into it.

Nothing reads misses on its own yet. They're the evidence the upkeep turn
(step 4) will start from.

## The prompt block

Every turn, an agent that has the `commitment` tool gets its open and waiting
commitments behind the history, open ones first:

```
## Your commitments

- trip-planner-anniversary-surprise-dinner-in-lisbon "Anniversary surprise dinner in Lisbon": open, last update just now, private
- trip-planner-book-a-fado-night "Book a fado night": open, from a person, last update just now
- trip-planner-lisbon-trip-nov-12-16 "Lisbon trip, Nov 12-16": waiting on a person to pick a hotel, 3/5, next: Shortlist three hotels near Alfama, check: Friday, last update just now
```

- A commitment someone handed over says who, from its `from`: "from a
  person" for one handed over on the agent's page. The same line appears in
  `about` and `commitment list`.

- At most ten, then a count of the rest ("…and 3 more; commitment list shows
  them"). The block keeps to its 400-token budget by adding lines only while
  they fit, so long lines mean fewer of them, and the count of the rest is
  always there. One line longer than 400 characters is shortened and ends in
  "…".
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

## Pages

Open an agent in the web UI (`#/agents/<name>`) and you see its page first.
Its settings, what the Agents page showed before, are on the Settings tab
next to it (`#/agents/<name>/settings`). The page shows, by default in this
order:

| Section | Id | Shows |
|---|---|---|
| What I'm for | `about` | The profile's purpose, what it takes on and how to ask, and the agent's page note, in its own words. With no profile, the configured description, marked as such |
| Working on | `working` | Open commitments: goal, next step, how to tell it's done, a progress bar (or the step it's on), next check, autonomy, how long since it moved. Open one for its dated updates |
| Waiting on you | `waiting` | Commitments waiting, with what each waits on |
| Recent results | `results` | Commitments done in the last two weeks, with the day |
| Docs | `docs` | Title, summary and when it was last reviewed. Click one to read it in place |
| Questions nobody could answer | `misses` | Misses in its area from the last two weeks. Left out when there are none |

Under them, **Hand it something** takes a goal and, if you like, how you'll
know it's done. It opens a commitment the agent owns, shared, `from: "a
person"`, written as you, with "Handed over by a person on this page." as its
first update. The agent sees it in its "Your commitments" block on its next
turn; when it can't (it has no `commitment` tool, or `pin` is off), the page
says which. A name that only has a profile left, an agent since removed, can't
be handed anything.

A page with nothing open, waiting, finished or written up, as every agent's is
right after you turn the directory on, says so in one line instead of four
empty sections, so the form sits near the top.

The page changes as the records do, from the same stream the State page
reads: an update the agent posts, a doc it reviews, something you hand it.
No reload.

The Agents list (`#/agents`) shows each agent's purpose line, or its
configured description, and how much it has open and waiting. An online
agent's card also shows its state (running, paused, off, error, idle) and
today's runs and tokens.

### How an agent arranges its page

The agent decides what its page shows and in what order. It never types a
figure: every count, bar and date comes from a record.

```
directory(action: "page",
          note: "I keep your trips moving. I ask before I book anything.",
          order: "waiting, working",
          hide: "docs",
          add: { title: "Hotel shortlist", type: "hotel", where: { shortlisted: true }, orderBy: "price", limit: 5 })
→ Saved your page. People see your page as, in order:
  - waiting: Waiting on you
  - working: Working on
  - about: What I'm for, with your note "I keep your trips moving. I ask before I book anything."
  - results: Recent results
  - misses: Questions nobody could answer, when there are some
  - hotel-shortlist: "Hotel shortlist", up to 5 hotel records, by price
  Hidden: docs.
  Under them, people can hand you a commitment.
```

- **`note`**: a sentence or two for people, at most 300 characters. An empty
  one takes it away.
- **`order`**: section ids, first shown first. The ones it leaves out keep
  their usual places after them.
- **`hide`**: section ids to leave out, replacing the list before. Empty
  shows them all. `waiting` and `misses` can't be hidden: a page that hid
  what waits on you, or what nobody could answer, would look better than the
  work it shows. If a person hid one of them, it stays hidden whatever the
  agent's list says.
- **`add`**: a section of its own, a titled list of the records a world-state
  query matches: `{ title, type, where?, orderBy?, limit? }`, as a `state`
  query takes them. The query runs as the agent first, so a type it can't
  read is refused, and the section keeps the scopes the agent could see then,
  so the page never lists a record the agent couldn't find itself. A type
  people can't read (`access.read` without `user`) is refused too: the page
  reads as you, and would show an empty list. `limit` defaults to 5 and stops
  at 20; a page holds six sections of its own.
- **`remove`**: the id of a section it added. The usual sections are hidden,
  not removed.

An argument sent as `null` is no change, so `page` with every argument null
reads the page.

A section it adds is drawn as a [list bound to a query](./agent-interfaces.md#lists-that-show-records),
the same list it could send in a chat, kept current the same way. Until the
first read comes back it says "Loading…", and if the records can't be read it
says so rather than showing an empty list.

The layout is the `page` record, so you can change it yourself on the State
page, including hiding a section the agent can't.

### With the directory off

The page shows the configured description, a line on how to turn the
directory on, and the settings below it, as the Agents page did before. The
Agents list shows configured descriptions without counts.

## HTTP

Behind the usual bearer auth, as a person: every scope.

| Route | Returns |
|---|---|
| `GET /api/ext/builtin:directory/agents` | `{ agents: [{ name, profile, description?, commitments: { open, waiting, done }, docs }] }`: every agent (the agent registry and `config.agents`, as Discord counts them) and anyone with a profile. `profile` is the profile's data or `null`; `description` is the configured one |
| `GET /api/ext/builtin:directory/agents/:name` | `{ name, profile, description?, page, commitments, docs, misses }`: the profile and page records or `null`, and lists of full records, private ones included. `404` for a name that is neither an agent nor a profile |
| `POST /api/ext/builtin:directory/agents/:name/commitments` | Hands the agent a commitment. Body `{ goal, doneWhen? }`. `201` with `{ commitment, inPrompt, why? }`, where `inPrompt` says whether the agent will see it in its prompt block and, when it won't, `why` is `"tool"` (no `commitment` tool) or `"pin"` (the block is off). `400` without a goal, or one longer than 300 characters. `404` for a name that is no agent, including one that only has a profile left |

Counts and lists read at most 5,000 records of each type. The routes come and
go with the directory; see [Changing it while TAI runs](#turn-it-on). A
request already on its way when a reload turns the directory off answers
`404` with "The directory is turned off."

## Not yet

- **Nothing acts on a commitment.** `nextCheck` is text, `autonomy` is a
  label, and no turn is started for either. Watchers, schedules and the
  upkeep turn come later in the [build order](./ownership-design.md#build-order).
- **No room records or room pages.** A room's own commitments and docs, owned
  by its lead, and its page, are step 5.
- **Pages are in the web UI only.** An agent's page on the wall of its home in
  the 3D world, and Board widgets in the same vocabulary, come later.
- **A store that fails fails the search.** All four types usually share one
  store, so `directory search` names them and reports the store's error
  rather than an empty result.
