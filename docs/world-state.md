# World state

Typed records that agents, people and plugins share: plans, bookings, things
being tracked. Every record says who last changed it and through what, every
change is announced on the runtime bus, and the store behind it is a plugin
like any other.

This page is what works today. The full design, including what comes next, is
in [world-state-design.md](./world-state-design.md).

## Declaring a type

```yaml
state:
  backend: sqlite          # the default; any registered provider id works
  types:
    - name: plan
      description: A multi-step plan someone is working through.
      scope: room          # where a new record lands: global | room | agent | project
      title: name          # the field that names a record in a list
      schema:
        type: object
        required: [name]
        properties:
          name:   { type: string }
          status: { type: string, enum: [draft, active, done] }
      access:              # omit for everyone
        read: ["*", user]  # `*` is every agent, `user` is a person via the UI or API
        write: [planner, user]
      search:              # omit to keep the type out of search
        fields: [name]     # the fields that say what a record is about
```

Every write is checked against `schema`. Core enforces a subset of JSON Schema:
`type`, `enum`, `const`, `required`, `properties`, `additionalProperties`,
`items`, numeric and length bounds, and `pattern`. A keyword outside that set
is reported by `validateConfig` rather than silently trusted.

## How agents use it

Once at least one type exists, agents get one tool, `state`, with eight
actions, and a ninth, `search`, once some type opts into
[search](#searching):

| action | does |
|---|---|
| `types` | what exists, each type's fields, the fields search reads, and whether this agent can write it |
| `get` | one record by id |
| `query` | records matching `where`, e.g. `{"status": "active"}` or `{"priority": {"gte": 3}}`; `includeArchived: true` adds archived ones |
| `search` | records about `text`, closest first, from the types that opt in; offered only while one does. See [Searching](#searching) |
| `put` | create a record (omit `id` for a generated one), or replace one by id |
| `patch` | change some fields; a field set to `null` is removed |
| `delete` | remove a record; its history is kept |
| `archive` | retire a record, with an optional `reason`: it is kept, but queries leave it out |
| `unarchive` | bring an archived record back |

A failed write comes back as a sentence the model can act on: which field, what
it expected, what it got. A version conflict says to read the record again.

The tool is not offered while no type exists, so a deployment that does not
use world state pays nothing for it in the prompt. `tools.state.enabled: false`
withholds it everywhere.

## Pinning state to an agent's prompt

An agent can see some records without asking for them. List queries under its
`state.context`, and the records they match render into its prompt on every
turn, as they are at that moment:

```yaml
agents:
  planner:
    state:
      context:
        - { type: plan, where: { status: active }, limit: 5 }
        - { type: note, orderBy: -updatedAt }
```

The planner's prompt then carries a block like this, behind the conversation:

```
## Current state

plan where {"status":"active"}:
1 plan record(s):
- trip "Lisbon trip" (version 3, global): {"name":"Lisbon trip","status":"active"}

note by -updatedAt:
No note records match.
```

- **What a query takes:** `type`, plus optional `where` (as in a `state`
  tool query), `orderBy` (a field, `-` in front for newest or largest first),
  `limit` (default 10) and `scope`.
- **What it shows:** exactly what the agent could read with the tool: its own
  scope, the rooms the turn is about, the current project, and `global`.
  Archived records are left out. "No records match" is shown too, so the
  agent knows without checking.
- **Size:** a query that hits its `limit` says there may be more, and the
  whole block is capped at about 2,000 tokens, with a note when it is cut.
- **Errors:** a query that fails, such as one naming a type that does not
  exist or one the agent may not read, is left out and logged once. The rest
  still render.
- **Every agent:** set it under `agent.defaults.state.context`. An agent's
  own list replaces the default list rather than adding to it.

Pinned records cost prompt space on every turn, so pin what the agent acts on
and leave the rest to the tool. What pinning saves is the lookup: measured on
a local 27B model, an agent with its plans pinned answered "which plans are
active?" from the block with no tool call, before and after the records
changed mid-conversation, where the same agent unpinned queried every time.
Both answered correctly.

## Searching

Name the fields that say what a record is about, and agents can find records
by what they mean, not only by an exact field match:

```yaml
state:
  types:
    - name: guide
      title: title
      search:
        fields: [title, summary, tags, updates.text]
```

- **Which fields:** top-level (`summary`) or dotted (`owner.name`). Strings
  and numbers are read as text, and an array or object is read through to
  the text inside it, so `tags: [travel, lisbon]` works, and `updates.text`
  reads the `text` of every entry in `updates`. A type without `search` is
  never indexed or searched, and neither is one whose `fields` isn't a list
  of names (`fields: title` rather than `fields: [title]`); TAI warns about
  that at load.
- **Asking:** the `state` tool's `search` action takes `text`, and optionally
  `type` (one, several comma-separated, or none for every searchable type),
  `scope`, `limit` (default 8) and `includeArchived`. Over HTTP it's
  `GET /api/state/search?q=`. In code,
  `StateService.search(caller, { text, types?, scope?, limit?, includeArchived? })`
  returns `{ hits: { record, score, how }[], partial }`. When no type you
  can read is searchable, a search says so instead of finding nothing.
- **What comes back:** the closest records first, each saying how it matched
  and when and by whom it last changed:

  ```
  2 match(es) for "hotel prices in Lisbon", closest first:
  - doc/lisbon-hotels "Lisbon hotels" (meaning 0.82, version 3, global, updated 2026-10-19T09:12:00.000Z by trip-planner): {...}
  - commitment/lisbon-nov "Lisbon, Nov 12-16" (words 0.67, version 7, agent:trip-planner, updated ... by trip-planner): {...}
  ```

- **Who sees what:** exactly what a `query` shows the same caller: types it
  can read, scopes it can see, and archived records only when asked. A person
  through the API sees every scope.

### Meaning and words

With embeddings on (`memory.embeddings`, the same embedder `recall` uses), a
search matches by meaning: "somewhere to stay in Portugal" finds "Lisbon
hotels" with no word in common. Without them, it matches words: the share of
your query's words a record contains, rare words counting for more than
common ones, with case and accents ignored and words like "the" left out.
Each hit says which it was.

Meaning needs each record embedded, which happens in the background:

- **On a write** to a searchable record, its search text is queued to be
  embedded, unless it hasn't changed. A write never waits for the embedder,
  and a failing embedder never fails a write.
- **Until then,** the record is still found, by words. So is a record whose
  text changed since its vector was made: a vector counts only while it
  matches the record's current text, the embedder that made it is still the
  one configured, and it is as long as the query's. That last one catches a
  different model answering to the same name, such as a gateway alias that
  now points elsewhere: the next search finds those records by words and
  embeds them again.
- **At start and after every reload,** TAI queues each searchable record
  that has no current vector. Change the embedding model and everything is
  embedded again, in the background.
- **Paced:** up to 16 records per call, at most one call a second, so a
  backfill of thousands doesn't flood a local embedder. After three failed
  calls in a row the queue is dropped; the next backfill or search fills it
  again.
- **Deleting or erasing** a record drops its vector. Archiving keeps it, so
  restoring one costs no embedding.

Vectors live in the runtime database's `state_search` table, keyed by type
and id, with the record's scope, the embedder's model, and a hash of the text
they were made from. The table never decides what anyone sees: a search reads
its candidates through the store, scoped as a query is, and takes only their
vectors from the table. So search works with any state provider.

**When a search can't read everything.** A search reads a type's records and
scores them in process, which is quick for a few thousand records per type.
Past 5,000 it reads the 5,000 most recently updated. A store that hands back
the same page twice (one that ignores `offset`) stops the read there, and a
store that fails is left out when you didn't name its type, so one store
that is down doesn't sink every search; name the type and the search fails
with that store's error. Each of these lands the type in `partial`, which the
tool passes on to the agent ("Not every doc record could be searched, so one
missing here may still exist"), so a miss there isn't read as proof that no
such record exists. Each also logs a warning once.

**Scores.** Meaning scores and words scores come from different measures but
are ranked together, so a caller that wants a cut-off should set one for
each.

## Types that come with the 3D world

With an avatar configured, the built-in places plugin declares the types the
[3D world](./live-sessions.md#an-avatar) keeps: `place` (each room),
`whereabouts`, `wear`, `visit` and `talk`, and for the things agents make
there, these. A type of the same name in your config wins, as with any type a
plugin declares; `todo`, `habit` and `note` also give way to another plugin's
type of the same name.

| type | scope | holds |
|---|---|---|
| `model` | agent | a model an agent made from parts, `<agent>:<name>`: `name`, `owner`, `mount` (`floor`, `wall` or `on`), `size`, `parts` (each a `shape`, `size`, `at`, `turn?`, `color`, `finish?` and `face?`), `about?`, and `from`, the ready-made model it was copied from. Written by the `build` tool, and by `place` when it makes a ready-made model an agent's own; a face carries the id of the interface component that shows it. See [Things agents make](./live-sessions.md#things-agents-make) |
| `todo` | agent | `title`, `done?`, `due?`: what a to-do board shows while it is still to do, and you tick done |
| `habit` | agent | `name`, `today?`, `streak?`: what a habit tracker shows and you tick. Each morning, in the deployment's time zone, the places plugin sets `today` back to false and counts `streak`, the days in a row it was done |
| `note` | agent | `title`, `note?`, `seen?`: what a notes card shows, its `note` as the card's text; **Got it** sets `seen` |

Ticks and buttons on a model's face write these as you, so an agent that wants
to know subscribes to their changes or pins them to its prompt.

The world draws an archived record as gone, the same way its lists leave it
out: an archived room drops off the map and nobody is in it, an archived
`whereabouts` or `visit` leaves the agent at home, an archived `body` or
`wear` is not worn, and an archived model is left out of the rooms it was in.
Restoring it puts it back. Two things stay: an agent's home room, since an
agent always has one, and a door to an archived room, so restoring the room
joins it up again. A change the world makes over an archived record, such as
an agent changing how it looks, writes a fresh record over it. The place
tool's `undo` leaves an archived room alone, since writing over it would
bring it back.

## Types that come with the directory

The built-in directory plugin, when you turn it on, declares `profile`,
`commitment`, `doc` and `miss`: what each agent is for, the work it has taken
on, what it has written up, and searches nothing answered. All four are
searchable. Agents read them through `state` but change their own only
through the directory's tools; people edit any of them here. A type of the
same name in your config wins, as with any type a plugin declares, and the
directory warns at load when one does: that declaration's `access` and
`search` then apply, so "only the owner changes it" no longer holds. See
[the directory](./directory.md).

## Scopes

Each record has one scope: `global`, `agent:<name>`, `room:<ref>` or
`project:<id>`.

- An agent sees records in `global`, its own `agent:` scope, the rooms it was
  woken in, and the current project. A record in another agent's private scope
  reads as absent, not as forbidden.
- A person through the HTTP API sees every scope.
- A new record lands where its type's `scope` says. A room-scoped type written
  from a turn spanning several rooms has to name its scope.

## Versions, deletes and history

A record's `version` goes up by one on every write. Pass `expectedVersion` to
write, or delete, only if nobody else has written since. A delete is a tombstone: the record stops
appearing, and its history keeps the removal. Erasing a record and its history
outright is a separate admin action, never available to an agent.

## Archiving

Archive a record you want out of the way but not gone: a plan that finished,
a page nobody uses. It keeps its data and history, and it is left out of
everything that lists or loads records: `state` tool queries, pinned state,
lists and tables on interfaces, the 3D world, and the State page. Fetching it
by id still works, and says it is archived, when, by whom and why. A card
bound to it shows the same as its first line.

- **Asking for archived records:** `includeArchived: true` on a `state` tool
  query, `?includeArchived=1` over HTTP, or **Show archived** on the State
  page.
- **Bringing it back:** `unarchive`, or **Restore** on the State page.
- **Changing an archived record:** a `patch` is refused with a message that
  says to unarchive it first. A `put` replaces it whole and brings it back, as
  a `put` over a deleted record creates it again. An archived record still
  exists, so a create with `expectedVersion: 0` is refused.
- **Deleting:** an archived record can be deleted like any other. What an
  agent wants gone is usually better archived; the `state` tool's `delete`
  stays a delete.
- **Versions:** archiving and restoring are writes: the version goes up,
  `expectedVersion` applies, and history logs each one.
- **Who may:** the same as for any write. An agent archives what its type's
  `access.write` and its scopes let it change.
- **Reading by id, in code:** `get` (and `GET /api/state/:type/:id`) returns
  an archived record too, with `archivedAt` set. Code that reads a record by
  id and treats it as current should check `archivedAt`, as the built-in
  places plugin does; `query` already leaves archived records out.

## Events

Every create, update and delete emits `state.changed` with the record before
and after, the actor, and the source. A plugin that writes for an agent, as
the directory's tools do, stays the actor and names the agent in
`source.onBehalfOf`; the change is then that agent's own to subscriptions, and
reads `commitment/x updated by plugin directory for planner`. Archiving and restoring are updates
too, so a hook or subscriber written before archiving existed keeps working.
To tell them apart, read `lifecycle`: `"archived"` on the update that archived
the record, with `archiveReason` when one was given, and `"unarchived"` on the
one that brought it back (including a `put` over an archived record). Neither
changes the data, so `before` and `after` are the same. A subscription line
reads `plan/trip archived by planner: the trip is over`.

A consumer that keeps its own copy of a type's live records, such as a page
that read the list once and follows the stream, must drop a record on
`lifecycle: "archived"` and add it back on `"unarchived"`. Otherwise an
archive looks like an edit, and the copy keeps showing a record every list
leaves out.

```yaml
hooks:
  on:
    state.changed:
      - when: { type: plan, op: update }
        tool: notify_owner
        args: { message: "plan {{id}} changed" }
```

## Waking agents on a change

`subscriptions:` says which agents hear about which events, and when. It works
for any runtime event, not only `state.changed`:

```yaml
subscriptions:
  # every plan change in the last five minutes, in one turn
  - agent: planner
    on: state.changed
    when: { type: plan, op: update }    # the hooks.on matcher: exact, or /regex/
    deliver: batch
    window: 5m
    instructions: Reconcile the calendar with the plan.

  # a morning summary of new tasks, posted in a room
  - agent: assistant
    on: task.created
    deliver: digest
    every: weekdays at 7am               # an interval, a phrase, or cron
    target: { room: standup }

  # never woken for these, but shown them on its next turn
  - agent: researcher
    on: state.changed
    when: { type: source }
    deliver: record
```

| `deliver` | when the agent hears |
|---|---|
| `immediate` | a turn now |
| `queue` (default) | a turn after `rooms.batchSeconds`, so a burst of events becomes one turn |
| `batch` | a turn `window` after the first event, with everything that arrived in between. Later events do not push it back |
| `digest` | a turn on the `every` schedule, with whatever accumulated; nothing accumulated, no turn |
| `record` | no turn of its own: the events appear in the agent's next turn, whatever woke it, under "Since your last turn" |

Each event reaches the agent as one line written when it happened, such as
`plan/trip updated by a person (web): status: draft → active`, plus the
subscription's `instructions`.

**Where the turn runs.** `target: session` (the default) runs it in the agent's
own `subscriptions:<agent>` session; a reply there reaches nobody unless the
agent sends it somewhere, and the prompt says so. `target: { room: <name or
ref> }` runs it in that room, through the room's own turn order and hourly
ceiling, and the agent can `pass`.

**Brakes.**
- An agent is not told about changes it made itself, including ones a plugin
  made for it (`source.onBehalfOf`), unless the subscription sets
  `includeOwn: true`.
- Session wakes share the rooms' hourly ceiling (`rooms.maxWakesPerHour`), per
  agent; room wakes use the room's.
- A wake refused by a ceiling or by pausing agents is held and retried every
  minute for up to an hour, then dropped with a warning.

**Nothing waiting is lost.** Pending events are stored, so a restart re-arms
every batch and digest on its original schedule. Changing a subscription so
that it receives different events, or delivers them somewhere else, discards
what was waiting for the old one, with a warning.

`validateConfig` names a subscription that would never deliver anything: an
unknown agent, an event nothing emits (with the nearest real one), a batch with
no `window`, a digest with no usable `every`, or a room that is neither declared
nor a `backend:id` ref.

## The State page

**State** in the web UI's sidebar lists every type and its records. Open a
record to see its data, who changed it last and through what, and its
history. A change from anywhere (an agent's tool call, a subscription, a
plugin, another browser) appears as it happens, and the changed row is
briefly highlighted.

Edit a record as JSON, archive it, or delete it. A save carries the version
you opened, so if an agent changed the record while you were editing, the
save is refused rather than overwriting the agent's change. The page warns
you as soon as that happens. Your edits are recorded as yours: actor `user`
`owner`, source `http`.

Archived records are hidden until you tick **Show archived**. Then each one is
dimmed and marked archived, with when, by whom and why. **Archive** asks why
(you can leave it blank). An archived record you open, from a link or right
after archiving it, stays open with a note saying it is archived and a
**Restore** button; restore it before editing it. History names each archive
and restore, with the reason.

## HTTP API

Behind the usual bearer auth. A person through the API sees every scope.

| route | does |
|---|---|
| `GET /api/state/types` | every type, with `canWrite` |
| `GET /api/state/:type` | records; `?where=<json>&orderBy=-field&limit=&offset=&scope=`. Archived records only with `includeArchived=1` |
| `GET /api/state/:type/:id` | one record, or 404. An archived record comes back with `archivedAt`, `archivedBy` and `archiveReason` |
| `GET /api/state/:type/:id/history` | its changes, most recent first |
| `GET /api/state/search` | records about some text, closest first: `?q=<text>&types=a,b&scope=&limit=`; `{hits: [{record, score, how}], partial: [type]}`, where `partial` names the types not read in full. Archived records only with `includeArchived=1`. `400` without `q`, for a type that isn't searchable, or when no type is |
| `GET /api/state/events` | a server-sent event stream: a `change` event carrying each `state.changed` payload as it happens; `?type=` narrows it to one type |
| `POST /api/state/:type` | create: `{id?, scope?, data}`; `201` with the record. An `id` that exists is `409` |
| `PUT /api/state/:type/:id` | replace the data: `{data, scope?, expectedVersion?}` |
| `PATCH /api/state/:type/:id` | change some fields: `{changes, expectedVersion?}`; a field set to `null` is removed |
| `DELETE /api/state/:type/:id` | delete; the history is kept. `?expectedVersion=` deletes it only while it is at that version, else `409`. `404` if there is no such record |
| `POST /api/state/:type/:id/archive` | archive: `{reason?, expectedVersion?}`; the record as archived. `409` on a version mismatch, `404` if there is no such record. Already archived, it comes back as it is |
| `POST /api/state/:type/:id/unarchive` | bring it back: `{expectedVersion?}`; the same answers as archive |

A write that does not fit the type is `400`, with the sentence an agent would
get, and so is a `PATCH` to an archived record, or an archive in a store that
can't archive. A write whose `expectedVersion` is out of date is `409`. Because
`/api/state/types`, `/api/state/events` and `/api/state/search` are routes, a
type named `types`, `events` or `search` cannot be listed over HTTP or on the
State page; TAI warns about one at load. Pick another name.

## Replacing the store

The SQLite provider registers through the same registry a plugin uses, so a
replacement is a plugin and a config line:

```ts
export default {
  register(ctx) {
    ctx.stateProviders.register("postgres", ({ options }) => new PostgresStateProvider(options));
    ctx.stateTypes.register({ name: "bookmark", description: "A saved link." });
  },
};
```

```yaml
state:
  backend: postgres
  options: { url: "${DATABASE_URL}" }
```

A single type can live elsewhere with `provider:` and `providerOptions:` on the
type, leaving the rest on the store-wide backend.

Core registers a second provider, `memory`, for state that is only true while
it lasts — what an agent is doing right now, who has a page open. Records live
in the process: gone on restart and on a config reload, with only each
record's latest changes kept (`providerOptions: { history: 50 }`, the default).
Queries, versions and events behave exactly as they do against SQLite, so a
type can move between the two without a reader noticing.

```yaml
state:
  types:
    - name: presence
      scope: global
      provider: memory
```

A provider only stores and retrieves (`get`, `query`, `put`, and optionally
`delete`, `archive` with `unarchive`, `history`, `purge`, `watch`).
Validation, access, scopes, versions and events are core's, so every provider
gets them without implementing them. A provider for data that changes outside
TAI implements `watch`, and core re-announces what it reports as
`state.changed`. Search asks nothing more of a provider: it reads through
`query`, with `scopes`, `includeArchived`, `orderBy`, `limit` and `offset`.

**Archiving, for a provider.** Archiving is optional. A provider without
`archive` and `unarchive` keeps working as before, and archiving one of its
records is refused with `The "<id>" store cannot archive <type> records, so
<type>/<id> is unchanged.`, so a record is never reported archived while it
stays live. A provider that implements them takes on four duties:

- `archive(ref, actor, reason?, source?, expectedVersion?)` and
  `unarchive(ref, actor, source?, expectedVersion?)` are writes: bump the
  version, set `updatedAt` and `updatedBy`, log an `update` with
  `lifecycle: "archived"` or `"unarchived"`, and return `{ record, previous }`,
  or null when there is no live record.
- `get` returns an archived record with `archivedAt`, `archivedBy` and
  `archiveReason`.
- `query` leaves archived records out unless `includeArchived` is set. Core
  also drops any archived record a query returns uninvited, so a provider
  that gets this wrong returns a short page rather than a hidden record, and
  core logs a warning the first time it happens.
- `put` writes the record live: one over an archived record brings it back,
  and logs `lifecycle: "unarchived"`. A put that comes back still archived
  fails loudly and announces nothing, rather than reporting a save that every
  query would leave out.

The SQLite provider adds its archive columns to an existing database when it
starts, and reads every older record as live.
