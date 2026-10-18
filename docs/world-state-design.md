# World state — Design

> Status: design, accepted. **Phase 1 is implemented**: see [world-state.md](./world-state.md)
> for what works today. First of three linked designs: this one (what
> agents know, structured), [agent interfaces](./agent-interfaces-design.md)
> (how they show it), and [live sessions](./live-sessions-design.md) (how they
> stay present while it changes).

## Goal

One structured, typed, observable layer for the state agents share: things,
plans, commitments, records. Agents, the UI and plugins all read and write it
through the same contract, every change is an event something can react to,
and the storage behind it is replaceable.

Today agents coordinate through conversation transcripts, and the structured
data that does exist is scattered:

| Store | Shape | Replaceable? |
|---|---|---|
| `facts` | category / entity / key / value, fixed table | no |
| `collections` | name / rating / location / url, fixed table built for one use | no |
| tasks | `TaskBackend` registry: native, github, beans, beads | yes |
| notes, chunks, core memory | `MemoryBackend` registry | yes |
| world state for simulations | `packages/evals/src/world.ts` | evals only |

Nothing tells an agent that data changed. An agent finds out by being woken for
some other reason and happening to look.

## What this is not

- **Not recall memory.** Notes, embedded chunks and core memory answer "what is
  relevant to this conversation?" — fuzzy, ranked, owned by the
  `MemoryBackend`. World state answers "what is true right now?" — exact,
  typed, queried by field. They stay separate contracts. State changes can be
  fed *into* memory for recall (a subscription, below), but neither replaces
  the other.
- **Not operational storage.** Sessions, messages, approvals, the audit log,
  cron and workflow runs stay where they are. The boundary the
  [memory registry](./memory-storage-registry.md) drew still holds.
- **Not a database.** No joins, no query language. Filters on fields, an
  order, a limit. A deployment that needs more owns a provider that offers it.

## The model

### Records

```ts
interface StateRecord {
  type: string;            // open string: "plan", "task", "collection_item", …
  id: string;
  scope: string;           // memory's scope tokens: "global", "agent:planner",
                           // "project:abc", plus "room:<ref>"
  data: Record<string, unknown>;   // validated against the type's schema
  version: number;         // optimistic concurrency
  updatedAt: string;
  updatedBy: Actor;        // who: { kind: "agent" | "user" | "plugin" | "system", name }
  source?: Source;         // through what: { tool?, surface?, interfaceId? }
}
```

`updatedBy` and `source` are provenance. They are on every record and every
change from the first version, because a later injection-defence layer needs
to know whether a value came from the user or from a web page, and that cannot
be retrofitted onto data that never recorded it.

### Types

```yaml
state:
  types:
    - name: plan
      description: A multi-step plan someone is working through.
      scope: room            # default scope for new records
      title: name            # field used when a record is shown in a list
      schema:                # JSON Schema; core validates every write
        type: object
        required: [name, steps]
        properties:
          name:   { type: string }
          status: { type: string, enum: [draft, active, done] }
          steps:  { type: array, items: { type: object, properties: {
                      text: { type: string }, done: { type: boolean } } } }
      access:
        read: ["*"]
        write: [planner, user]
```

A type comes from config, from a plugin (`registerStateType`), or from an agent
that is allowed to define types. `name` is an open string; core keeps no list
of known types and privileges none of the ones it ships.

## Replaceable at two levels

### The whole store

```yaml
state:
  backend: sqlite        # open string; `options` is opaque to core
  options: {}
```

The built-in SQLite provider registers through `registerStateProvider` like any
plugin. Swapping in Postgres, a CRDT store or a hosted database is a plugin and
a config line.

### One type at a time

```yaml
state:
  types:
    - name: task
      provider: tasks    # served by the configured TaskBackend, wherever it lives
```

A type can name its own provider. That is how consolidation works without
moving data: tasks stay in GitHub or beans, and appear in world state through
an adapter over the existing `TaskBackend`. One interface, many homes.

### The provider contract

Verb-shaped, following the memory registry's lesson: do not make a backend
speak our vocabulary.

```ts
interface StateProvider {
  id: string;
  get(ref: StateRef): Promise<StateRecord | null>;
  query(q: StateQuery): Promise<StateRecord[]>;   // field filters, order, limit
  put(input: StateWrite, expectedVersion?: number): Promise<StateRecord>;
  delete?(ref: StateRef): Promise<boolean>;
  history?(ref: StateRef, opts?: HistoryOptions): Promise<StateChange[]>;
  /** For data that changes outside TAI (an issue edited on GitHub). */
  watch?(emit: (change: StateChange) => void): Disposer;
  close?(): Promise<void>;
}
```

Core owns everything around storage, so every provider gets it for free:
schema validation, access checks, change events, provenance, the tool, the HTTP
API and the context slot. A provider stores and retrieves; that is all.

`patch` is a core operation built on `get` + `put` with the version check, so a
provider does not have to implement partial updates to support them.

A version mismatch is an error returned to the writer, written for an agent to
act on ("this plan changed since you read it; read it again"). No automatic
merge in the first version.

## Change events

Every write emits `state.changed` on the runtime bus:

```ts
interface StateChange {
  type: string;
  id: string;
  scope: string;
  op: "create" | "update" | "delete";
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  version: number;
  actor: Actor;
  source?: Source;
  at: string;
}
```

It is an ordinary runtime event, so everything that already consumes the bus
works on it: `hooks.on`, plugins, the event journal. Providers with `watch`
emit the same event for external changes.

The built-in provider keeps an append-only change log, which gives `history()`,
an audit trail, and later replay, at no extra cost.

## Subscriptions: who hears about a change, and what they do

The question "should this event wake an agent, and how?" is the one rooms
already answer for messages, with `deliver` × `wakeOn` and one wake queue per
agent. Subscriptions generalise that answer to any event on the bus.

```yaml
subscriptions:
  # reconcile within a few minutes of any plan change, all changes in one turn
  - agent: planner
    on: state.changed
    when: { type: plan, op: update }      # same matcher as hooks.on
    deliver: batch
    window: 5m
    target: session                        # or { room: <ref> }

  # a click on a "page me" button should not wait for anything
  - agent: on-call
    on: interface.action
    when: { action: escalate }
    deliver: immediate
    target: { room: ops }

  # a morning digest of everything that changed overnight
  - agent: assistant
    on: state.changed
    when: { scope: global }
    deliver: digest
    schedule: "0 7 * * *"

  # never wake for it, but see it on the next turn
  - agent: researcher
    on: state.changed
    when: { type: source }
    deliver: record
```

| `deliver` | what happens |
|---|---|
| `immediate` | wake now, skipping the batching delay. Still respects pause and the hourly ceiling |
| `queue` | join the agent's wake queue with the normal delay, collapsing with other triggers |
| `batch` | hold for `window`, then deliver everything that accumulated in one turn |
| `digest` | deliver on `schedule` (cron) or `every` (interval) |
| `record` | never wake; the events are waiting in the agent's inbox on its next turn |

`target` decides where the woken turn runs and where its reply goes, using the
[schedules](./schedules.md) model: a room, or the agent's own session where it
acts through tools and posts nowhere unless it chooses to.

The wake carries the events rendered compactly ("plan *Trip* updated by the
user from the web: step 3 done"), plus an optional `instructions` line from the
subscription.

### Built on what exists

- **Matching** is the `hooks.on` matcher, so the same `when` syntax, the same
  validation, and a typo in an event name is a `validateConfig` warning rather
  than a subscription that never fires.
- **Delivery** is a new built-in event-hook handler kind, `wake`, so it
  registers through the same registry as every other handler.
- **Queueing** is the existing per-agent `WakeQueue`, generalised: entries are
  keyed by a source (a room ref today, any event source tomorrow) instead of a
  room ref only, and triggers become an open string. Room subscriptions keep
  their config and become one source among several.
- **Runaway protection** is the existing per-agent ceiling. A subscription does
  not see changes its own agent made unless it sets `includeOwn: true`, so an
  agent reacting to a plan by editing the plan does not wake itself forever.

## How agents use it

### One tool

```
state(action: "types" | "get" | "query" | "put" | "patch" | "delete", …)
```

One tool rather than six, because every tool costs attention and history
budget, and that cost is highest on the small local models TAI has to work
well on.

- `types` lists the types this agent can see, as a name, the description, and
  field names with their types: not the full JSON Schema, which is long and
  mostly noise to a model.
- A validation failure comes back as a correction naming the field and what it
  expected, never as a schema dump.

### A context slot, not a transcript

```yaml
agents:
  planner:
    state:
      context:
        - { type: plan, where: { status: active }, limit: 5 }
```

The current matching records render into the prompt every turn through a
context slot (`refresh: turn`, in the `slots_state` layer, with a budget core
enforces and reports). An agent sees what is true now without rereading forty
messages to reconstruct it. This is the structured half of what
[#417](https://github.com/quintonmiller/tailored-ai/issues/417) asks for.

### The UI and HTTP

- `GET /api/state/types`, `GET /api/state/:type`, `GET /api/state/:type/:id`,
  `GET /api/state/:type/:id/history`, and writes behind the same bearer auth.
- `GET /api/state/events` streams changes over SSE, which is what lets an
  interface update the moment a record changes.
- A State page to browse types, records and history.
- Dashboard widgets read state directly; "widgets that need data the agent
  maintains" stops meaning facts or collections.

## Consolidation

One migration per PR, each removing something:

1. **Collections** become the `collection_item` type on the built-in provider.
   The fixed table and its use-case-shaped columns leave core; the `collections`
   tool becomes a thin alias for a release, then goes.
2. **Tasks** become the `task` type served by a `TaskBackend` adapter. No data
   moves. `task.*` events keep firing and are mirrored as `state.changed`.
3. **Facts** become the `fact` type. A built-in subscription indexes them into
   the memory backend, so recall still finds them.

## Where it lives

| Tier | Owns |
|---|---|
| Core | the record model, `StateProvider` contract and registry, validation, access, events, `state` tool, HTTP API, context slot, `wake` handler, generalised wake queue |
| Built-in plugin | the SQLite provider; the `TaskBackend` adapter |
| Deployment | its own types, subscriptions and context queries |

## Phases

| # | Slice | Removes or enables |
|---|---|---|
| 1 | Contract, registry, SQLite provider, `state.changed`, `state` tool, read API | the foundation |
| 2 | Subscriptions: `wake` handler, generalised wake queue, five delivery modes | "notify these agents, this way" |
| 3 | Context slot for pinned queries | state in the prompt instead of transcripts |
| 4 | Migrate collections | a use-case table in core |
| 5 | `TaskBackend` adapter | tasks visible as state |
| 6 | Migrate facts | a second fixed table |
| 7 | State page, SSE stream | the UI half; needed by bound interfaces |

## Decisions

Settled in review:

1. **Agent-defined types are off by default.** An agent may define a type only
   when its config says `state.defineTypes: true`. Inventing a schema is
   powerful and is also the fastest route to five near-duplicate types.
2. **Scope widens, narrowest first.** A query from a room sees that room's
   records, then `global`, the way memory scopes widen, unless the query names
   a scope explicitly.
3. **Deletes are tombstones.** A delete records the removal in the change log
   so history survives; a hard delete is an admin action.
