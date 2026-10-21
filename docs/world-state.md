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
```

Every write is checked against `schema`. Core enforces a subset of JSON Schema:
`type`, `enum`, `const`, `required`, `properties`, `additionalProperties`,
`items`, numeric and length bounds, and `pattern`. A keyword outside that set
is reported by `validateConfig` rather than silently trusted.

## How agents use it

Once at least one type exists, agents get one tool, `state`, with eight actions:

| action | does |
|---|---|
| `types` | what exists, each type's fields, and whether this agent can write it |
| `get` | one record by id |
| `query` | records matching `where`, e.g. `{"status": "active"}` or `{"priority": {"gte": 3}}`; `includeArchived: true` adds archived ones |
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
an agent changing how it looks, writes a fresh record over it.

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

## Events

## Events

Every create, update and delete emits `state.changed` with the record before
and after, the actor, and the source. Archiving and restoring are updates
too, so a hook or subscriber written before archiving existed keeps working.
To tell them apart, read `lifecycle`: `"archived"` on the update that archived
the record, with `archiveReason` when one was given, and `"unarchived"` on the
one that brought it back (including a `put` over an archived record). Neither
changes the data, so `before` and `after` are the same. A subscription line
reads `plan/trip archived by planner: the trip is over`.

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
- An agent is not told about changes it made itself, unless the subscription
  sets `includeOwn: true`.
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
`/api/state/types` and `/api/state/events` are routes, a type named `types`
or `events` cannot be listed over HTTP; pick another name.

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
`state.changed`.

**Archiving, for a provider.** Archiving is optional. A provider without
`archive` and `unarchive` keeps working as before, and archiving one of its
records is refused with `The "<id>" store cannot archive <type> records`, so a
record is never reported archived while it stays live. A provider that
implements them takes on four duties:

- `archive(ref, actor, reason?, source?, expectedVersion?)` and
  `unarchive(ref, actor, source?, expectedVersion?)` are writes: bump the
  version, set `updatedAt` and `updatedBy`, log an `update` with
  `lifecycle: "archived"` or `"unarchived"`, and return `{ record, previous }`,
  or null when there is no live record.
- `get` returns an archived record with `archivedAt`, `archivedBy` and
  `archiveReason`.
- `query` leaves archived records out unless `includeArchived` is set. Core
  also drops any archived record a query returns uninvited, so a provider
  that gets this wrong returns a short page rather than a hidden record.
- `put` writes the record live: one over an archived record brings it back,
  and logs `lifecycle: "unarchived"`.

The SQLite provider adds its archive columns to an existing database when it
starts, and reads every older record as live.
