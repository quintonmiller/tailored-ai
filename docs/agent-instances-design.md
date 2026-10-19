# Agent instances and history scope: design

> **Status:** proposal, for review. Nothing here changes behaviour yet. Phase 1
> (chat and voice sharing one conversation) is being built alongside it.

You reach an agent in several places: Discord, web chat, the Talk page, rooms.
Today each place has its own conversation, so the agent you talk to out loud
has no idea what you told it in chat five minutes ago. Shared memory papers
over some of that, but it is not the same as talking to one being.

There is also the opposite need. Some agents are better treated as
**templates**: spin up ten researchers on ten questions, let them work
independently, collect what they found, and throw them away.

This doc proposes two settings on an agent definition that cover both:
`instances` (one persistent being, or a template you spawn) and `history`
(how conversations on different surfaces map to histories). It also covers
the pieces that make either setting work: awareness of what the instance did
elsewhere, one turn at a time when history is shared, and a body that belongs
to the instance.

## What happens today

A conversation is a row in the `sessions` table, found by a string key
(`findOrCreateSession` in `packages/core/src/agent/session.ts`). Each surface
builds its own key, and that key decides what the agent remembers:

| Surface | Session key | What that means |
|---|---|---|
| Discord message or DM | `discord:<userId>`, or `discord:<project>:<userId>` in a project-mapped channel | one history per person on Discord. Switching agents with the agent command starts a fresh session |
| Web chat | the `sessionKey` the page sends (`web:<timestamp>` when none) | one history per chat thread |
| Talk page (live session) | none: `startLiveSession` calls `newSession` | every call starts cold |
| Room | `room:<ref>:<agent>`, or `room:all:<agent>` with `roomSessionScope: shared` | one per room, or one across rooms |
| Agent-to-agent message | `dm:<from>:<to>`, or `room:all:<to>` when shared | one per correspondent |
| Subscription wake | `subscriptions:<agent>` | one per agent |
| Delegation | `delegate:<parentSessionId>:<uuid>` | fresh per call, never reused |
| Autopilot task | `autopilot:<taskId>` | fresh per task |

What every surface shares, whatever the key: core memory (per agent, in the
system prompt), notes (scoped to the agent that wrote them; facts are still
global), world state, project tasks and schedules.

Two existing pieces already point at this design:

- **`roomSessionScope: shared`** gives an agent one session across every room
  and direct message. [rooms.md](./rooms.md#one-memory-per-room-or-one-across-them)
  records what it costs ("an agent in fourteen rooms pays for all fourteen on
  every turn"). It also separates continuity of **conversation**, which history
  buys, from continuity of **work**, which durable state serves better.
- **Delegation and background tasks** are throwaway instances in all but
  name: a fresh session, its own run, a result returned or sent back with
  `notify`. Their registry is in memory, though, so results are dropped after
  an hour and nothing survives a restart.

Concurrency today: separate sessions run in parallel. Discord refuses a
second message from the same person while the first is running ("I'm still
working on your previous message"). Rooms take turns through the wake queue.

## `instances`: one being, or a template

| `instances` | What a spawn is | Lives |
|---|---|---|
| `single` (default) | there is no spawn: one persistent instance per definition | as long as the definition exists |
| `template` | a new instance with its own id, history and state | until its job is delivered, then archived |

`single` is how every named agent works today, so it stays the default. An
instance of a template is named after its definition plus a short id, for
example `researcher#7f3a`, and can carry a display name ("researcher 2") when
a person spawned it.

A template instance is what delegation already is, made visible. It gets an
id you can address, message and wait on. Its result is stored where it
survives a restart. When it ends, its history is archived rather than
deleted, so you can read back how it got there.

## `history`: how surfaces map to histories

| `history` | One history per | Good for | Cost |
|---|---|---|---|
| `thread` (default) | surface thread: a chat, a Discord person, a room, a call | isolation; today's behaviour | the agent is a different stranger in each place |
| `person` | person, across every surface | an assistant you reach by chat, voice and Discord | needs to know that the Discord user and the web user are the same person |
| `single` | instance | an agent that should remember everything it did, everywhere | context fills fastest, and conversations with different people mix |

`thread` stays the default, so nothing changes until an agent opts in.

`history: single` is `roomSessionScope: shared` extended from rooms and
messages to every surface. The two should not disagree. The simplest rule is
that `history` wins when set, and `roomSessionScope` keeps working on its own
for agents that never set `history` (see open question 3).

## Awareness: one being, whatever the scope

Even with `thread` history, an agent should know that ten minutes ago it told
someone on Discord it would book the table. Awareness gives each turn a short
digest of what the same instance did elsewhere recently:

```
Since your last turn, elsewhere:
- 14:02 Discord, with Sam: agreed to book a table for Friday; created a reminder
- 14:09 room #standup: posted the morning summary
```

Most of the machinery exists. Subscriptions already have `deliver: record`,
which shows events on the agent's next turn under "Since your last turn". What
is missing is the event. Nothing fires when an ordinary turn ends: the closest,
`agent.completed`, is specific to the task watcher. The plan:

- Fire a new `agent.turn_ended` event for every turn: agent, instance,
  surface, place, counterpart, and a one-line gist.
- Build the gist without a model call: the reply's first sentence plus the
  names of the tools it used. A summary call per turn would double the cost of
  every turn.
- Show the instance only its own turns from other threads, capped by count and
  age, as a turn-volatile context slot. It lands in the tail block behind the
  history, so the cached prompt prefix stays byte-identical. Voice depends on
  that.

Awareness is cheap, makes no change to history, and helps every scope, so it
is the first thing to build after phase 1.

## One turn at a time, when history is shared

Under `person` or `single`, two surfaces can write into the same history. Two
turns running at once on one history would interleave tool calls and replies
in an order neither turn saw. So a shared history needs a **per-instance turn
queue**, a generalisation of the rooms' wake queue:

- One turn at a time per history.
- Priority: voice first, then a person's direct message, then room and
  subscription wakes.
- A person writing again while a turn runs is queued, not refused.

Voice cannot wait behind a two-minute tool-using turn. This is where the
"fast talker, slow thinker" split from
[live-sessions-design.md](./live-sessions-design.md#fast-talker-slow-thinker)
earns its place. When the instance is busy, the voice turn runs anyway against
a snapshot of the history, plus one line saying what the busy turn is doing.
It can answer, or hand work to the slow side ("I'll check that once I've
finished this"). Its exchange is appended when the busy turn completes, so the
history stays in an order every turn actually saw.

## The body belongs to the instance

The avatar's position and activity are, for now, data kept by the page.
Every open tab runs its own wandering, and a reload resets it. Under this
design they become a world-state record per instance (`agent:<instance>`):
where it is, what it is doing, what it holds. Every surface reads the same
record. The page draws it, a Discord turn can be told it, and the activity
follows what the instance is actually doing: an instance mid-turn on Discord
sits at the desk typing.

Template instances get records too, which is what lets ten researchers
appear at ten desks in a shared space later.

## Keeping a `single` history inside the budget

**Labels.** Every message in a shared history carries where it came from, so
the agent can tell a Discord DM from the Talk page:

```
[Discord DM · Sam] Can you move Friday's booking to 8?
[Talk · Alex] What did Sam want?
```

The tail block names where the current turn is ("You are talking with Alex
on the Talk page"), so the agent knows who it is answering.

**Routing by turn, not by text.** A reply goes back to wherever the turn came
from. The agent cannot post Sam's answer into Alex's chat by getting a label
wrong, because it never chooses the destination.

**Budget.** `maxHistoryTokens` already trims the oldest messages first, and
compaction folds older turns into a summary. A single history leans on both
harder. Durable work belongs in tasks, notes and world state, which do not
grow the prompt, the same split rooms.md draws.

**Privacy.** This is the real cost. Under `single`, Sam's DM sits in the
history that Alex's chat reads, and so does any tool output from Sam's
conversation. `single` fits an agent that serves one person, or one whose
every conversation is public. For an agent that talks to several people,
`person` gives the one-being feel without mixing them. Whether `single` should
refuse to run with more than one person is open question 2.

## Config sketch

```yaml
agents:
  assistant:
    instances: single          # single (default) | template
    history: person            # thread (default) | person | single
    awareness: true            # its turns elsewhere, under "Since your last turn"

  researcher:
    instances: template
    template:
      maxConcurrent: 10        # live instances at once
      deliver: spawner         # who hears the result: spawner | a room | nobody
      keep: archive            # archive (default) | discard
      timeoutMinutes: 30

people:                        # who is who, across surfaces (for history: person)
  - id: owner
    name: Alex
    discord: "123456789012345678"
    web: owner                 # the web UI's signed-in user
```

**People.** `history: person` needs to know that a Discord account and a web
login are one person. `people:` maps surface identities to a person id;
identities it does not map are separate people. A single-user deployment
should need no `people:` block at all. The runtime already resolves an
operator (the owner of the primary channel), and the operator plus the web
UI's user can be one person by default.

## Template instances in more detail

**Spawning.** By a person ("put three researchers on this"), by another agent
through a `spawn` tool, by a workflow step, or by a subscription. `delegate`
becomes "spawn and wait", and `delegate(async, notify)` becomes "spawn and
tell me when it's done". The tool surface stays familiar; what changes is
that the instance is visible, addressable and durable.

**Limits.** `maxConcurrent` per template, plus a deployment-wide cap. On a
local model server the real ceiling is its slot count: NInfer on the
reference box runs three at once. So ten instances means a queue, not ten
parallel turns, and the docs should say so plainly.

**Lifecycle.** Spawned, running, delivered, ended, archived. An archived
instance keeps its history and records, read-only and browsable. `keep:
discard` deletes them once the result is delivered.

**Results.** Delivered to whoever spawned the instance, through the same path
as agent-to-agent messages today, and stored as a world-state record so a
restart does not lose them. That fixes the one-hour, in-memory limit
delegation has now.

**Depth.** Delegation is depth-1 today: a sub-agent cannot delegate. Template
instances need the same guard, or an explicit depth limit.

## Open questions

1. **Default for named agents.** Keep `thread`, or move to `person` once the
   identity map exists?
2. **`single` with several people.** Allow it with a warning, or refuse to
   start an agent with `history: single` that talks to more than one person?
3. **`roomSessionScope`.** Keep it as a separate setting, or make it
   shorthand for `history` and deprecate it?
4. **Voice while busy.** Answer from a snapshot (fast, and possibly unaware
   of what the busy turn is about to do), or wait (consistent, and silent for
   as long as the turn takes)?
5. **Template results.** Stored as world-state records by default, or only
   delivered?
6. **Nested spawns.** Can a template instance spawn instances of its own, and
   how deep?
7. **Archive retention.** How long do archived instances keep their history
   before a sweep removes it?

## Phases

Smallest first. Each one ships on its own, and phases 1 to 3 change nothing
for an agent that does not opt in.

1. **Chat and voice share one conversation.** *In progress.* The Talk page
   merges into Chat, and a live session uses the chat thread's session
   instead of a fresh one. That is the same history under every scope above.
2. **Awareness.** The `agent.turn_ended` event, and the "since your last turn,
   elsewhere" lines, behind a per-agent `awareness` flag.
3. **The body as instance state.** A world-state record per instance that
   the avatar and its activity read.
4. **`history: person`.** The `people:` map, sessions keyed by person, the
   operator mapped automatically.
5. **The per-instance turn queue.** Voice priority and the snapshot path for
   voice while busy. Required before `single`.
6. **`history: single`.** Source labels, routing by turn, leaning on
   compaction.
7. **Template instances.** Spawn, deliver, archive, durable results, and
   `delegate` rebuilt on top.
8. **Bodies for every instance in shared spaces.**
