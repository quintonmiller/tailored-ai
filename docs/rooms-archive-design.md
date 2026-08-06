# Archiving rooms — design

Why retiring a room works the way it does. Companion to
[rooms.md](./rooms.md#archiving-a-room), which is the user-facing description.

**Status: Phases 1 and 2 are built.** Phase 3 (reflecting the archive onto the
transport) and everything under "Deliberately deferred" are not. This document
is kept because the decisions below are the ones a reviewer would want to argue
with, and they are not visible from the code.

## The gap

A room can be opened three ways — `/room create`, `room(action="create")`, a
`rooms.rooms[]` entry in config — and cannot be closed at all. `RoomStore.removeRoom()`
exists at [store.ts:205](../packages/core/src/rooms/store.ts) and is called from **no
production path** — its only two callers are test setup;
`pruneConfigSubscriptions` removes subscriptions but never the room. Deleting a room
from `config.yaml` leaves its row, its subscriptions and its cursors behind.

Four things follow, and each of them is live in the reference deployment:

1. **`room(action="list")` grows monotonically.** Every room ever opened is in the
   output forever, one line each, in a tool result the model reads on every turn that
   touches rooms. Prompts earn their size; a finished trip room does not.
2. **A dead channel is retried forever.** The backoff described under
   [Rooms that are not there](./rooms.md#rooms-that-are-not-there) is 30 minutes, and
   it never gives up — deliberately, because "is this error permanent?" cannot be
   answered from an error message. Archiving is the answer that *can* be given, by a
   person, reversibly.
3. **A finished room squats its name.** `idx_rooms_name` is unconditionally unique
   ([schema.ts:486](../packages/core/src/db/schema.ts)), so `upsertRoom` throws
   `Room name "trip" is already used by discord:…` — and opening the *next* trip room
   is the most likely thing anyone wants after finishing one.
4. **Subscriptions to a finished room keep costing turns.** Poll timers still fire,
   `checkInMinutes` still fires, and a stray message in an abandoned Discord channel
   still wakes whoever was watching.

`removeRoom` is not the fix. It drops `room_subscriptions` and `room_members`, orphans
the `room_messages` rows the `local` backend keeps, and is irreversible — you cannot
un-delete a set of cursors, roles and check-in cadences. Every reason to retire a room
is a reason to keep its record.

## What archiving is

**A room-level flag that stops all wake activity, keeps the record, and releases the
name.** Concretely:

| | archived |
|---|---|
| appears in `room(action="list")` | no (a count line instead) |
| readable by name or ref | yes |
| wakes anyone — push, poll, check-in | **no** |
| can be posted to | no, with an error naming `unarchive` |
| subscriptions, cursors, roles, check-in cadence | kept, inert |
| transcript (`room_messages`, or Discord's own) | untouched |
| holds its name against a new room | no |
| reversible | yes |

Archiving is about TAI's attention, not about the transport. The Discord channel stays
exactly where it is unless someone opts into more (Phase 3).

## Decisions

Each of these could go the other way. They are written down because the reasoning, not
the choice, is what needs reviewing.

### D1 — Archive is room state, not subscriber state

One `archived_at` on `rooms`. A room is finished for everyone in it, or it is not
finished. "Stop waking *me* here" already exists twice over: `wakeOn: none` and
`unsubscribe`.

### D2 — Subscriptions survive archiving

This is the whole difference from `removeRoom`. The watcher refuses to arm or wake for
an archived room; the rows stay. Unarchiving therefore restores the room exactly as it
was — same members, same cursors, same roles — rather than handing you an empty room to
re-invite eleven agents into.

Cursors staying put has a consequence worth stating: unarchiving a room that saw traffic
while it was archived hands the watcher a backlog. That is correct (an agent should see
what it missed, per [Agents see what they missed](./rooms.md#agents-see-what-they-missed))
and it is bounded by `maxBacklog`, but it means unarchiving a busy channel is not free.

### D3 — Archived rooms release their name

`idx_rooms_name` becomes partial: `WHERE archived_at IS NULL`. Archiving `trip` lets you
open a new `trip`.

Two consequences to handle, not to hope about:

- **`getRoomByName` must prefer the live room.** `resolve()` tries names before refs
  ([store.ts:170](../packages/core/src/rooms/store.ts)), so the query needs an explicit
  ordering that puts `archived_at IS NULL` first. Without it, which of two same-named
  rooms you get is whatever SQLite feels like.
- **Unarchiving can now collide.** If `trip` was archived and a new `trip` exists,
  unarchive must fail with a message naming the live ref and asking for a rename, not
  silently produce two live rooms answering to one handle.

The alternative — archived rooms keep their names — makes unarchive trivially safe and
makes the common case impossible. Rejected on that basis.

### D4 — Archived rooms stay readable, and refuse writes

`read`, `members`, `purpose` (read) keep working: the record is the point of not
deleting it. `post`, `update`, `react`, `invite`, `subscribe` and `purpose` (write)
refuse with a message that names the room and says `unarchive` restores it.

Refusing to post is the arguable half. The case for it: a message into a room nobody
watches is a message that vanishes, and the error is self-explanatory and one call from
being resolved. The case against: an agent wanting to leave a closing note cannot. The
closing note belongs *before* the archive, and Phase 2 posts one automatically.

### D5 — Agents may archive, and it is announced

`room(action="archive")` is available to agents, like `create` already is. Archiving is
reversible, and the alternative — a person is the only one who can retire anything —
does not match a deployment where agents open rooms for themselves.

The asymmetry that makes this worth stating: **one agent archiving silences every other
subscriber.** Three mitigations, all of which must ship together with the action:

- the archive is announced in the room, by `builtin:room-announcer`, **before** the room
  goes quiet, naming who archived it and why;
- `reason` is required from the tool path (not from the slash command — a person typing
  `/room archive` in the channel has already made the decision visible);
- in-flight turns are not killed. Archiving stops *new* wakes.

If this proves wrong in practice, the narrow fix is a config switch that makes archiving
human-only, not removing the action.

### D6 — Config `archived` is a tri-state, and absence means "leave it alone"

```yaml
rooms:
  rooms:
    - name: trip
      ref: discord:333…
      archived: true      # archive on next reconcile
```

`archived: true` archives, `archived: false` un-archives, **absent leaves the stored
state untouched**. Absence cannot mean "not archived", because `reconcileRooms()` runs on
every config reload and would resurrect every room an agent archived at runtime.

This is deliberately *not* the `batch` convention, which is written explicitly on every
reconcile so deleting the key turns it off. The difference is where the authority sits:
batching is a config opinion, archiving is usually a runtime act.

It is also exactly the shape that has bitten this deployment before — a `COALESCE` on
`check_in_minutes` meant removing the key from config kept the stored value, and the file
and the database disagreed with no way to tell from the file. So: the tri-state gets a
test asserting all three cases, and `/room archive` prints the stored state rather than
the config's.

### D7 — The transport is not touched by default

Discord has no "archive" for text channels (only threads carry `archived`). What people
mean by archiving a Discord channel is either locking it (deny `SendMessages` for
`@everyone`) or moving it under an Archive category — both are opinions, both need
`Manage Channels`, and neither is required for TAI to stop watching.

So Phase 1 and 2 touch nothing on the transport. Phase 3 adds the optional seam.

### D8 — Archive is the reversible act; delete stays out of scope

No hard-delete surface, no retention sweep. `removeRoom` keeps its two test callers and
gains no production one. If a room genuinely must be erased, that is a decision worth
making by hand against the database, with the transcript in front of you.

## Phase 1 — state and enforcement — **built**

Self-contained, testable against the `local` backend with no transport connected.

### Schema — `packages/core/src/db/schema.ts`

Base `CREATE TABLE rooms` (line ~462) gains:

```sql
  -- When this room was retired. NULL means live. A timestamp rather than a
  -- boolean so "when did we stop watching this?" is answerable, matching
  -- messages.rewound_at.
  archived_at    TEXT,
  archived_by    TEXT,
  archive_reason TEXT,
```

and the name index becomes partial:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_name_active
  ON rooms(name) WHERE archived_at IS NULL;
```

Migration, appended to the existing `ALTER TABLE` list at line ~684 (three columns), plus
a separate step that drops the old index and creates the new one. New index *name*, so
the base schema's `CREATE ... IF NOT EXISTS` does not silently keep the old unconditional
one on an existing database. SQLite has supported partial indexes since 3.8.0; the bundled
better-sqlite3 is on 3.49.

### Store — `packages/core/src/rooms/store.ts`

- `Room` gains `archivedAt?`, `archivedBy?`, `archiveReason?`; `toRoom` carries them.
- `archiveRoom(ref, by?, reason?)` / `unarchiveRoom(ref)`. Unarchive throws on a live-name
  collision (D3) with a message naming the conflicting ref.
- `listRooms(opts?: { includeArchived?: boolean })` — **excludes archived by default**, so
  every existing caller (`LocalRoomBackend.listRooms`, `publishPurposes`, the tool's
  `list` and its "Known rooms:" error) gets the right behaviour without being edited.
- `getRoomByName` orders live before archived.
- `upsertRoom`'s clash check considers only live rooms.
- `listActiveSubscriptions()` — subscriptions joined against non-archived rooms. Added as
  its own method rather than filtering at each call site, because the watcher has five
  arming paths and forgetting one is a silent "this agent simply never spoke again".

### Events — `packages/core/src/events.ts`

`room.archived` and `room.unarchived`, carrying `{ roomRef, name, by?, reason? }`.
Reusing `room.membership_changed` would be wrong twice: nobody joined or left, and the
announcer's join/leave wording would be wrong.

### Watcher — `packages/core/src/rooms/watcher.ts`

The correctness surface. Six gates, each with a test:

| where | why it needs its own gate |
|---|---|
| `start()` (line ~591) | arm from `listActiveSubscriptions()` — no poll timer, no check-in timer, no push fan-out |
| `onMessage()` (line ~870) | the Discord push listener is **per backend, not per room**, so an archived room's traffic still arrives. Early return before `noteRoomTurn`, so a retired room's chatter does not move a counter either |
| `runWake` (line ~1315) | a queue entry may already name a room archived since it was enqueued. `getRoomByRef` is already read at line ~1355 and its null is tolerated; archived needs an explicit early return above the wake charge |
| `runCheckIn` (line ~816) | fires on a timer that may outlive the archive by one interval |
| `runBatchedWake` | drop archived rooms from the batch before the prompt is built, keeping their cursors — the same shape as the per-room pause drop already documented |
| `publishPurposes()` (line ~644) | do not rewrite the Discord topic of a room you have retired |

Plus: `warnAboutRoomlessSubscribers` (line ~780) reads active subs, or it warns about
retired rooms on every boot forever; and the watcher subscribes to `room.archived` /
`room.unarchived` and calls the existing `scheduleRearm()`, so archiving takes effect
without a restart exactly as membership changes already do.

### Tool — `packages/core/src/tools/room.ts`

- Two actions: `archive` (requires `reason`) and `unarchive`.
- `list` (line ~227) excludes archived, and appends one line when there are any:
  `3 archived rooms. Name one to read it, or action="unarchive" to reopen it.` A count
  line rather than an `include_archived` parameter — the parameter costs a schema entry
  the model has to discover, the line costs eight tokens and cannot be missed.
- `requireRoom` still resolves archived rooms; the mutating actions check the flag (D4).
- `readAll` (line ~286) skips archived rooms — it iterates the agent's subscriptions, and
  those survive archiving by design.
- `dm` refuses when the agent's `desks` entry points at an archived room.

**Cost to weigh:** this takes the action list from 14 to 16 and lengthens an already long
`action` description. Both are prompt budget on every turn an agent carries the tool.
Worth measuring on the deployed 27–31B model before and after, per the repo's own rule
about not trusting remembered limits — and worth trimming the description in the same PR
if the measurement says so.

## Phase 2 — human surfaces and plugins — **built**

### Discord — `packages/core/src/channels/discord-room-commands.ts`

| command | notes |
|---|---|
| `/room archive [reason:…]` | run inside the room. The announcer posts publicly; the confirmation is private |
| `/room unarchive` | run inside the same channel |

Both operate on the channel they are run in, rather than taking a room name.
The design sketch called for `unarchive name:…` with autocomplete over archived
rooms, on the grounds that discovery needed solving — but the Discord channel
does not go anywhere when the room is archived, so "go to the channel and run
`/room unarchive`" is already the discoverable path, and a name argument would
be a second way to say the same thing. Agents needing to name a room use the
tool, whose `list` reports what is archived.

Every existing subcommand needs a decision in an archived room: `members` and `purpose`
(read) work; `ping`, `all`, `status`, `add`, `reset` and `rewind` refuse with the
unarchive hint, because all of them either wake an agent or edit a seat that is currently
inert. `/room create` colliding with an archived name is now legal and logs that it
reused a retired name.

### Config and reconcile — `packages/core/src/config.ts`, `runtime.ts`

`archived?: boolean` on the `rooms.rooms[]` entry type, honoured in `reconcileRooms()`
([runtime.ts:1036](../packages/core/src/runtime.ts)) with the tri-state from D6. An
archived declared room is not re-pointed and not re-purposed. Declared *subscriptions*
into an archived room are still written — they are inert, and keeping them is what makes
unarchive restore the declared set.

### Plugins

- `builtin:room-announcer` gains archive and unarchive lines, subscribing to the new
  events. This is the mechanism behind D5, so it ships in the same PR as the tool action,
  not after it.
- `builtin:dm-mirror` and `builtin:error-room` resolve a target room by name and must
  refuse loudly when it is archived — `dm-mirror` already has exactly this refusal shape
  for loop-unsafe configuration. Errors posted into a room nobody reads is the precise
  failure `error-room` exists to prevent.

## Phase 3 — optional transport-side archive — **not built**

```ts
interface RoomCapabilities { /* … */ archive: boolean }
interface RoomBackend {
  /** Reflect the archive on the transport. Optional: TAI's own archive does not need it. */
  archiveRoom?(id: string, archived: boolean): Promise<void>;
}
```

Discord implements it as lock-and-move: deny `SendMessages` for `@everyone`, and move the
channel under a category named by config. Opt-in per deployment:

```yaml
rooms:
  archiveOnTransport: false      # default
  archiveCategory: Archive
```

Off by default because it needs `Manage Channels`, because it is visible to everyone in
the guild, and because a failure here must not stop TAI's own archive from succeeding —
the transport step is best-effort and logged, never load-bearing.

## Deliberately deferred

Proposed, not planned. Each is a good idea that is a worse idea to build blind.

- **Auto-archive on persistent backend failure.** The 3-strikes-then-30-minutes backoff
  could escalate to an archive after, say, 24 hours of unbroken failure. Tempting, and
  exactly the class of change that has misfired here before: four guards in a row caused
  the failure they were meant to prevent. If it ships, it ships as
  `rooms.autoArchiveAfterHours`, **off by default**, and it *posts* before it archives.
- **Archive on inactivity.** Same shape, weaker justification: silence is not a signal.
- **Retention / hard delete.** See D8.
- **A rooms UI.** There is no rooms surface in `packages/server` or `packages/ui` at all
  today, so archiving cannot regress one. Whenever that surface lands, an archived filter
  is one line of it.

## Tests

Extending what is already there, by file:

- `rooms-core.test.ts` — archive/unarchive round trip; name released and reusable;
  unarchive collides and says which ref; subscriptions and cursors survive;
  `listRooms()` excludes and `{ includeArchived: true }` includes; `getRoomByName` prefers
  the live room over an archived namesake.
- `rooms-tool.test.ts` — `list` excludes and shows the count line; `read` and `members`
  work; `post`, `invite`, `subscribe` refuse; `readAll` skips; `archive` without `reason`
  is rejected.
- `rooms-watcher.test.ts` — no poll timer, no check-in timer; a push message into an
  archived room wakes nobody **and does not move `agent_turns`**; a queued wake for a
  room archived after enqueue is dropped without charging budget; unarchiving re-arms
  without a restart.
- `rooms-batched-wake.test.ts` — an archived room is dropped from the batch and keeps its
  cursor.
- `room-announcer.test.ts` — the archive line is posted before the room goes quiet.
- A migration test on a database created before the column existed: it gets the columns,
  the old unconditional index is gone, and two same-named rooms are possible only when
  one is archived.

## Tier and shipping

Tier 1 — core platform. It is a missing state in a core subsystem's contract, not a
feature for one deployment, and it changes the seam (`RoomBackend.capabilities`) rather
than any one backend's behaviour. Phase 3's Discord lock-and-move is the tier-2 half and
is why it is a separate phase.

Docs: [rooms.md](./rooms.md) gains an "Archiving a room" section, and rows in the tool
action table, the slash command table, the storage table and the config reference.

Changesets: **`patch`** on every touched package, per the pre-v1 guard.
