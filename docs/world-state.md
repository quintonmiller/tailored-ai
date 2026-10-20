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

Once at least one type exists, agents get one tool, `state`, with six actions:

| action | does |
|---|---|
| `types` | what exists, each type's fields, and whether this agent can write it |
| `get` | one record by id |
| `query` | records matching `where`, e.g. `{"status": "active"}` or `{"priority": {"gte": 3}}` |
| `put` | create a record (omit `id` for a generated one), or replace one by id |
| `patch` | change some fields; a field set to `null` is removed |
| `delete` | remove a record; its history is kept |

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
  "No records match" is shown too, so the agent knows without checking.
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
plugin declares.

| type | scope | holds |
|---|---|---|
| `model` | agent | a model an agent made from parts, `<agent>:<name>`: `name`, `owner`, `mount` (`floor`, `wall` or `on`), `size`, `parts` (each a `shape`, `size`, `at`, `turn?`, `color`, `finish?` and `face?`), `about?`, and `from`, the ready-made model it was copied from. Written by the `build` tool, and by `place` when it makes a ready-made model an agent's own; a face carries the id of the interface component that shows it. See [Things agents make](./live-sessions.md#things-agents-make) |
| `todo` | agent | `title`, `done?`, `due?`: what a to-do board shows and you tick |
| `habit` | agent | `name`, `today?`, `streak?`: what a habit tracker shows and you tick |
| `note` | agent | `title`, `note?`, `seen?`: what a notes card shows; **Got it** sets `seen` |

Ticks and buttons on a model's face write these as you, so an agent that wants
to know subscribes to their changes or pins them to its prompt.

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

## Events

Every create, update and delete emits `state.changed` with the record before
and after, the actor, and the source:

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

Edit a record as JSON, or delete it. A save carries the version you opened,
so if an agent changed the record while you were editing, the save is
refused rather than overwriting the agent's change. The page warns you as
soon as that happens. Your edits are recorded as yours: actor `user`
`owner`, source `http`.

## HTTP API

Behind the usual bearer auth. A person through the API sees every scope.

| route | does |
|---|---|
| `GET /api/state/types` | every type, with `canWrite` |
| `GET /api/state/:type` | records; `?where=<json>&orderBy=-field&limit=&offset=&scope=` |
| `GET /api/state/:type/:id` | one record, or 404 |
| `GET /api/state/:type/:id/history` | its changes, most recent first |
| `GET /api/state/events` | a server-sent event stream: a `change` event carrying each `state.changed` payload as it happens; `?type=` narrows it to one type |
| `POST /api/state/:type` | create: `{id?, scope?, data}`; `201` with the record. An `id` that exists is `409` |
| `PUT /api/state/:type/:id` | replace the data: `{data, scope?, expectedVersion?}` |
| `PATCH /api/state/:type/:id` | change some fields: `{changes, expectedVersion?}`; a field set to `null` is removed |
| `DELETE /api/state/:type/:id` | delete; the history is kept. `?expectedVersion=` deletes it only while it is at that version, else `409`. `404` if there is no such record |

A write that does not fit the type is `400`, with the sentence an agent would
get. A write whose `expectedVersion` is out of date is `409`. Because
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
`delete`, `history`, `purge`, `watch`). Validation, access, scopes, versions
and events are core's, so every provider gets them without implementing them.
A provider for data that changes outside TAI implements `watch`, and core
re-announces what it reports as `state.changed`.
