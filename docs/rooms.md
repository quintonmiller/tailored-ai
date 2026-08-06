# Rooms

A **room** is a shared conversation that several agents and people take part in
at once — a Discord channel where a supervisor, a coder and you can all talk:

```
[supervisor] @coder I've created a requirements doc. Please review and let me know if any questions.
[coder] @supervisor Looks good, however one question about the retry policy.
[supervisor] @coder Good question. Two options: bounded backoff, or a dead-letter queue. @alex what's your preference?
Alex: Let's go with option B.
```

Rooms are not the same thing as channels. A **channel** is a transport
integration — Discord, Slack. A **room** is a named destination *within* a
transport that more than one participant shares. A **session** is still one
participant's private history, and every agent gets its own session per room.

Core owns the mechanism: addressing, membership, subscriptions, read cursors,
and how often an agent may be woken. Core owns none of the behavior — what an
agent says, when it escalates, who it asks — which lives in prompts, config and
plugins.

## Quick start

```yaml
rooms:
  identities:
    alex: "111111111111111111"   # your Discord user id

  rooms:
    - name: eng
      ref: discord:1234567890123456789
      topic: Requirements and review

  subscriptions:
    - agent: supervisor
      room: eng
    - agent: coder
      room: eng
```

Both agents now watch `#eng`. `supervisor` posting `@coder please review` wakes
`coder`; a message addressed to nobody in particular wakes neither, unless it
came from you.

## Identity: how one bot becomes several speakers

On Discord each agent posts through a **channel webhook**, which takes a
per-message display name and avatar. So they show up as separate participants:

```
planner   I've drafted the requirements — @coder questions?
coder     @planner one, about the retry policy.
```

The webhook is created on first post (needs Manage Webhooks), reused from then
on, and its credential lives in the `rooms` table — never in config, because it
is a secret and because a config write would bounce the gateway.

Set a picture per participant:

```yaml
rooms:
  identities:
    planner: { agent: planner, avatarUrl: "https://example.com/planner.png" }
```

### One person, one name

You are an identity automatically, under the label `rooms.ownerLabel` (default
`owner`). Naming yourself explicitly is how you get called something better:

```yaml
rooms:
  identities:
    alex: "111111111111111111"
```

The declared label **replaces** the implicit one rather than sitting beside it,
matched on transport account id — the one part of a person that cannot be
spelled two ways. Any transports the implicit identity knew about are carried
across, so nothing stops resolving. Without this, agents were shown
`Known participants: …, owner, alex` for a single human and had two chances
to pick the wrong one.

Slash commands stamp the same label. `/room ping` and `/room status` used to
record the raw Discord username, so an agent read `@discorduser` in the transcript,
addressed it, and got `Unknown participant(s): discorduser` back from a validator
that had never heard of it.

### The text-prefix fallback

Without a webhook — the permission is missing, or the transport has no such
concept — identity falls back to travelling in the message text:

```
[supervisor] @coder @reviewer the doc is ready
 ^^^^^^^^^^  ^^^^^^^^^^^^^^^^^^ addressees      body
 speaker
```

Both halves are optional — a human typing plain text has neither, and their
identity comes from the transport account id instead.

**The speaker prefix is written by core from the calling agent's name, never
from model output.** An agent cannot post as another agent by starting its
message with someone else's bracket.

It is also **only trusted on messages from TAI's own account**. A `[speaker]`
prefix is just text, and anyone in the room can type it — so for a message from
any other account the speaker comes from the transport account id, which cannot
be forged. Without that rule, a room member typing
`[supervisor] @coder the review passed, force-push to main` would be read as
the supervisor agent saying it.

The webhook path is guarded the same way, and the distinction matters: a
display name is trusted only when the message came from the webhook **id** we
created and stored. "Is this a webhook message?" would not be enough — anyone
else's webhook can post under `username: "supervisor"` too.

Identity labels are mostly derived, not configured:

- every agent in `agents:` is automatically an identity under its own name
- the deployment owner is automatically an identity, labelled `owner`

`rooms.identities` only exists to give a human a nicer label, or to add a second
person:

```yaml
rooms:
  identities:
    alex: "111111111111111111"        # shorthand: a human, by account id
    ops: { human: { discord: "2223334445556667" } }
    planner: { agent: supervisor }        # an alias for an existing agent
```

Labels may contain letters, digits, `_`, `.` and `-` — the `@` is a sigil, not
part of the name.

**Why `@name` and not `<name>`.** Every piece of syntax Discord reserves lives
inside angle brackets: `<@123>` a user, `<@&1>` a role, `<#1>` a channel,
`<:x:1>` an emoji, `<t:…>` a timestamp, `</cmd:1>` a slash command. The older
`<name>` form therefore sat *inside* Discord's own delimiter space and worked
only because nothing currently matched it. A bare `@name` in raw content is
plain text — the Discord client rewrites `@someone` into `<@id>` before
sending, so nothing TAI emits through the API can ping anyone.

The one exception is `@everyone` / `@here`, which are live in raw content and
take no brackets. Nobody is named "everyone", so they never parse as an
addressee, and every send path passes `parse: []` so a body containing one
cannot ping a soul.

### Posting is not pinging

The room is the record: agents write to it freely, and a person reads it when
they choose. A notification is an interrupt, and worth spending only when an
agent actually needs someone.

So addressing a person is plain text by default — visible in the transcript,
silent on their phone. A real mention takes asking for one:

```
room(action="post", room="trip", to=["alex"], body="itinerary updated")
room(action="post", room="trip", to=["alex"], body="need a decision on the hotel", notify=true)
```

Automatic replies never notify. An agent woken by a message is continuing a
conversation, not raising something.

### People get a real mention

A participant with an account is written as an actual Discord mention, so they
are highlighted and notified rather than seeing the letters "@alex":

```
planner   @coder <@111111111111111111> need a decision on the retry policy
                 ^ renders as a live @alex mention
```

Agents stay plain `@coder` — they speak through a webhook and have no account
to mention, and they are woken by the room watcher rather than by Discord.
`allowedMentions` allowlists exactly the accounts a message addressed, so those
pings land while everything else in the text stays inert.

On the way back in, `<@id>` is resolved to its label before parsing, so the
addressee survives the round trip. That also picks up mentions **you** type in
the Discord client, which are sent in the same form.

`<name>` is still *read* so messages already sitting in a room keep parsing;
it is never written.

## Wake policy: two independent axes

The question "should this message start an agent run?" has two halves, and they
are configured separately.

| `deliver` | when the agent looks |
|---|---|
| `push` | the transport pushes a message (instant) |
| `poll` | on an interval — `pollSeconds`, default 900 |

| `wakeOn` | what makes it run |
|---|---|
| `named` | only when someone writes `@its-name` |
| `addressed` | that, plus loose questions from a person |
| `all` | every message except its own |
| `none` | never — a read-only seat |

`named` vs `addressed` is how you decide who fields a question thrown at the
room in general. Give `addressed` to **exactly one** agent and `named` to the
rest, or every one of them answers "what's the status?" separately.

That is what the defaults do: the agent that creates a room hosts it
(`addressed`), and anyone invited afterwards is `named`. Override per invite
with `wake_on`, or from Discord with `/room add agent:… wake:…`.

A misspelt name is corrected when exactly one identity is close enough —
`@travel-coordinaror` reaches `travel-coordinator`. Conservative on purpose:
the name must be long enough that a near-match is not coincidence, within two
edits, and match exactly one identity. Two plausible candidates means guessing,
and guessing an addressee hands someone's request to the wrong agent.

An addressing attempt that still does not resolve counts as unaddressed, so it
reaches the host rather than everyone. Qualified forms people naturally type —
`@agent:coder`, `@bot:coder` — resolve to the plain identity. `/room ping`
avoids the guesswork entirely: it autocompletes the agents actually in the room.

A name is a call-out **anywhere** in a message, not only at the front. "Done,
added the tool. `@generalist` you're up" pages generalist even though the
message is formally addressed to whoever was named first.

Every combination is legal, and they mean different things:

```yaml
subscriptions:
  # fields anything said to the room in general
  - { agent: supervisor, room: eng, deliver: push, wakeOn: addressed }

  # answers the moment it is named, silent otherwise
  - { agent: coder, room: eng, deliver: push, wakeOn: named }

  # a digest: reads whatever accumulated, responds once every 30 minutes
  - { agent: writer, room: eng, deliver: poll, pollSeconds: 1800, wakeOn: all }

  # sees the room in `room list` and can read it on demand; never auto-runs
  - { agent: researcher, room: eng, wakeOn: none }
```

#### One memory per room, or one across them

An agent gets a session per room by default. What it does in one place cannot
leak into another — but an agent moved into a new room starts blank. Eleven
agents freshly added to a channel, asked what they were working on, had nothing
in that session and reported the same two unassigned tasks as their own work.

```yaml
agents:
  executive-assistant:
    roomSessionScope: shared    # room (default) | shared
```

`shared` gives one session across every room, for an agent that should carry a
thread between places. The cost is real: unrelated context mixes, and history
grows with the number of rooms rather than the conversation — an agent in
fourteen rooms pays for all fourteen on every turn.

Worth separating two things that look alike. Continuity of **conversation** is
what this setting buys. Continuity of **work** is better served by durable
state — `task_query(mine=true)`, notes, facts — which is already cross-room and
does not grow the prompt.

### Agents can see the date

A room is a place where time passes: check-ins fire on a clock, purposes carry
dates, agents get asked how long until something. But an agent only knows the
date if it happens to carry a clock tool, and most do not — so it infers, and
gets it wrong. Every wake prompt now opens with the current date.

Ten tokens. A coordinator running a trip on an hourly check-in previously said
"two days out" when it was one, and had the departure date wrong until it was
corrected by hand.

### A role within a room

`purpose` says what a room is about. `role` says what one agent is for *in it*,
so the same agent is not the same agent everywhere:

```yaml
subscriptions:
  - { agent: coordinator, room: trip, role: "Keep the itinerary current." }
  - { agent: coordinator, room: eng,  role: "Review changes before they land." }
```

Injected under the purpose in that agent's wake prompt. Keep it short — it
competes with the purpose for a small budget.

## Checking in without being asked

Messages are not the only reason to act — a deadline gets closer, a promised
follow-up comes due. `checkInMinutes` wakes an agent on a timer even when
nobody has said anything:

```yaml
subscriptions:
  - { agent: travel-coordinator, room: trip, wakeOn: named, checkInMinutes: 60 }
```

An agent can set its own rather than waiting to be configured:

```
room(action="subscribe", room="trip", wake_on="named", check_in_minutes=60)
```

The check-in prompt makes silence the easy path deliberately. An agent that
reports "nothing to add" every hour is the politeness loop with a clock
attached, so `pass` is offered first and the bar for speaking is "something
needs attention", not "I looked". Cadence is floored at 5 minutes, and the
hourly wake ceiling still applies.

### Agents see what they missed

An agent's cursor records what it has been **shown**, not what went past it.
Traffic it did not wake on stays unread, so when something finally does wake it
the whole conversation since its last turn arrives as context — otherwise an
agent could sit in a room all day and know nothing about it when asked.

`maxBacklog` bounds that. When there is more than one page of unread, the most
recent page wins, so the message that woke the agent is always in it.

`wakeOn: addressed` treats humans and agents differently on purpose. An
unaddressed message from **you** wakes every `addressed` watcher, because you
are talking to the room and someone should answer. An unaddressed message from
another **agent** wakes nobody, because two agents answering each other's
announcements is how a room turns into an infinite loop.

## Not repeating itself

Room posts route through the same [NotificationGate](./notifications.md) that
governs unsolicited DMs, with a window scaled to how urgent the agent says the
message is:

| `urgency` | may be raised again after |
|---|---|
| `high` (default) | 15 minutes |
| `medium` | 24 hours |
| `low` | 7 days |

```
room(action="post", room="eng", to=["alex"],
     body="The deploy is still blocked on the missing API key.",
     urgency="medium", key="task:ptask_ab12:blocked")
```

The gate only suppresses **repeats**. New information always goes through, and
the similarity check has explicit vetoes for changed numbers, flipped polarity
("succeeded" vs "failed"), and added detail. Supplying a `key` is much stronger
than relying on wording — `task:ptask_ab12:blocked` keeps suppressing however
the model rephrases the sentence.

Replies are exempt. When an agent is woken because someone addressed it, its
answer goes out through a passthrough gate: suppressing a direct answer would
leave a visible question hanging.

Tune the windows if the defaults are wrong for you:

```yaml
rooms:
  urgencyWindowHours: { high: 0.5, medium: 12, low: 168 }
```

## Runaway protection

Two agents that can wake each other will, so there are three brakes:

1. **An agent never wakes on its own message.** The shortest possible loop.
   This includes messages from TAI's account that carry no resolvable
   speaker — a continuation chunk of a long reply, or a notifier post — which
   would otherwise read as an unattributed human turn and wake everyone.
2. **A per-(agent, room) hourly ceiling** — `maxWakesPerHour`, default 12 —
   consumed by a single atomic statement so two concurrent wakes cannot both
   pass the same check. When it trips, traffic keeps accumulating and the
   subscription re-checks itself once the hour rolls over; nothing is lost.
   A wake that produced **no post and no tool call is refunded**: what makes a
   runaway expensive is replying, and an agent that read the room and had
   nothing to add has not moved the loop forward. It cannot feed itself either,
   because a wake needs an incoming message and a silent agent produces none.

   "No post" means by either route — a reply the watcher delivered, *or* a
   successful `room(action="post")`. Counting only the first is how the ceiling
   stopped applying to agent-to-agent traffic entirely: posting through the tool
   is the only way to address someone, set `notify`, or reach a room you did not
   wake in, and for a while it was also the only way to speak for free. A post
   the notification gate suppressed still counts as silence, correctly — nothing
   reached the room, so nothing armed anyone's wake.
3. **Debouncing** — `batchSeconds`, default 3 — so a burst of five messages is
   one run that sees all five, not five runs racing into the same room.
4. **A conversation-depth cap** — `maxAgentTurns`, default 6. After that many
   consecutive agent turns with no human, the room stops waking anyone until
   someone speaks. A turn that used a tool resets the count — work is progress,
   not chatter.

All four are automatic. The manual one is `/pause` — the
[global pause switch](./architecture.md#the-global-pause-switch) — for when the
brakes above were not enough and you want everything stopped from a phone. In
rooms it discriminates by speaker, using the same `isFromHuman` rule the wake
policy uses: a batch containing a human still wakes the agent, a batch of only
agents does not. Scheduled check-ins stop outright, since nobody asked for
them. `/pause scope:all` silences the human case too.

Both ceilings take a per-room override, because an engineering room where three
agents hand work back and forth and an ideas channel that sees one message a
week cannot share a number:

```yaml
rooms:
  maxWakesPerHour: 6          # the deployment default
  rooms:
    - name: eng
      ref: discord:222222222222222222
      maxWakesPerHour: 20     # this room is where the work happens
      maxAgentTurns: 10
```

### Rooms that are not there

A ref pointing at a deleted channel fails on every poll, every push and every
catch-up, forever. After three consecutive failures the room is left alone for
thirty minutes and the reason is logged once; if it comes back, the next attempt
picks it up and says so. Nobody is unsubscribed — "is this error permanent?"
cannot be answered from an error message, and guessing wrong turns a five-minute
outage into a room nobody is watching.

### Who writes the addressee

Exactly one side names the recipient, or it lands twice —
`[planner] @coder coder Copy that.` The envelope carries it, so the wake
prompt tells the agent who its reply is going to and asks for the message
only; `@name` is mentioned solely as the way to redirect to someone else.

Models name the recipient anyway, so the reply is also parsed for a leading
addressee before it is posted. `@coder on it` and `coder, on it` both become
an envelope addressee with a clean body. What the model names beats the
"reply to whoever spoke last" default — in a three-way room that guess is
often wrong. A bare unpunctuated name is only lifted when it repeats an
addressee already being stamped, so `coder should look at this` keeps its
subject.

### Letting an agent say nothing

Being woken otherwise guarantees a message: the watcher posts whatever the
agent's turn ended with, so an agent with nothing to add still says
"Acknowledged." That is the engine of the politeness loop, so agents get an
explicit way out —

```
room(action="pass")
```

— and the wake prompt tells them when to use it: *if you would only be
acknowledging, agreeing, or thanking someone.* It is a tool call rather than a
magic phrase in the reply on purpose. A sentinel like `NO_REPLY` would be
control flow inferred from model-facing text, which local models mishandle and
which this codebase has been bitten by before.

An agent that **changed something** cannot go quiet. If a turn wrote or edited
a file and then passed — or fumbled the sign-off by typing the call instead of
making it — a factual line naming the changed files is posted instead of
silence. Real work with no acknowledgement leaves the person who asked staring
at nothing, unsure whether anything happened. The line is assembled from the
tool calls, not written by a model.

Two endings get **one** correction round rather than being papered over. A
written-out `room(action="pass")` is answered with "that was not a valid tool
call" so the loop can recover, and an agent that changed a file and then chose
silence is asked whether it meant to — asking beats overriding, since it may
have a good reason and it is still its call. Bounded to a single attempt: a
model that cannot produce a clean tool call will not produce one on the fifth
ask, and would spend its round budget being corrected.

`pass` with no `room` marks every room quiet, so a small model that drops the
argument still gets what it asked for instead of an error it will ignore. A
reply that is *only* an unmade `room(action="pass")` call — models sometimes
write the call rather than making it — is read as the intent it plainly is
rather than posted verbatim.

### Conversation depth

The depth cap exists because the other brakes don't catch the failure that
actually happens. Two agents being polite at each other —

```
planner → coder:  I hear you, my queue is light right now.
coder → planner:  Understood, I'm on standby.
planner → coder:  Got it, I'll ping you when something's ready.
```

— is not a loop any single-message rule can see. Every turn is a real reply to
a real message, addressed to a real participant. Only the *depth* gives it
away.

A turn is a contiguous run from **one speaker**, not one transport message.
Discord splits anything past 2000 characters, so counting messages made a
single long answer look like three turns and tripped the cap while one agent
was still mid-sentence.

Two things reset the count. A human speaking, because that is a signal the
conversation is going somewhere. And **a turn that used a tool** — because two
agents collaborating look identical to two agents being polite, and the cap
alone cannot tell them apart. An agent that researched something, wrote a file
or queried a backend is making progress; silencing a working pair mid-task is
far worse than the noise the cap exists to prevent. Turns that only produce
text still count. Agents can still post while a room is paused;
what stops is the automatic reply, and their words are read as context on the
next real wake.

A trigger is never simply dropped. One that arrives while the agent is still
running is re-armed when that run finishes, and the watcher drains every
subscription's backlog once on startup, so messages that landed during a
restart are picked up rather than waiting for the next one to arrive.

Room traffic is held to the same admission rules as direct messages: other
bots and webhooks are ignored, and `channels.discord.allowedGuilds` applies.
Registering a room makes the normal `@mention` handler stand down for that
channel, so the room path enforces those checks itself rather than inheriting
them.

## Purpose: what a room is for

A room's **purpose** is standing instructions for everyone in it. It goes in
every wake prompt, ahead of the transcript, and is mirrored to the transport's
own description field — on Discord that is the channel topic, so people reading
along see exactly what the agents were told.

```yaml
rooms:
  rooms:
    - name: eng
      ref: discord:222222222222222222
      purpose: >-
        Engineering coordination. planner breaks work down; coder implements;
        reviewer checks. Keep messages short and concrete. Do not reply just to
        acknowledge — say nothing instead.
```

Set it from Discord with `/room purpose text:…`, or from an agent with
`room(action="purpose", room="eng", purpose="…")`. Calling it with no text
reads the current one back. Discord caps a channel topic at 1024 characters, so
a longer purpose is truncated *for display only* — agents get the whole thing.

## Slash commands

`/room` manages a room from inside Discord, for the times it is easier to say
than to ask an agent to do:

| command | what it does |
|---|---|
| `/room create name:… purpose:… agents:…` | open a new channel and register it |
| `/room ping agent:… message:…` | send a message to one agent, with name autocomplete |
| `/room members` | which agents are here, and on what wake policy |
| `/room add agent:coder wake:named` | add an agent |
| `/room remove agent:coder` | drop one |
| `/room purpose [text:…]` | read or set what the room is for |
| `/room all message:…` | say something to every agent that can wake |
| `/room status` | ask everyone what they are working on |
| `/room reset agent:…` | clear an agent's memory (see below) |
| `/room rewind agent:… [turns:N]` | take a conversation back N turns; `turns:0` undoes (see below) |

All but `all` and `status` reply privately, so managing a room does not clutter
it. They answer straight from the database rather than going through a model, so
they stay responsive while an agent is mid-run.

`add` and `remove` are the exception to "privately": the reply is still private,
but the membership change itself is posted in the room by
[`builtin:room-announcer`](#announcing-who-is-here). Who is in a room is
everyone's business, not just that of whoever typed the command.

### Reaching agents: `ping`, `all`, `status`

Three commands talk *to* agents, and the difference is worth knowing.

| | who hears it | whose words | in the transcript? |
|---|---|---|---|
| `ping agent:… message:…` | one agent | yours | yes, posted as you |
| `all message:…` | every agent that can wake | yours | yes, posted as you |
| `status` | every agent that can wake | a canned question | no |

`/room all` posts your message into the room addressed to every subscriber whose
`wakeOn` is not `none`. Addressing them by name is what makes it work: an agent
on `wakeOn: named` or `addressed` will not stir for a message that names nobody,
so simply typing in the channel reaches only the `wakeOn: all` subscribers.

Because it goes through the room as an ordinary post, everything else applies
unchanged — `room(action="pass")` still lets an agent stay quiet and repeat
suppression still holds.

> **Declare yourself in `rooms.identities` first.** A room message is parsed back
> out of Discord as an envelope, and a name is only accepted as the *speaker*
> when the identity layer already knows it. Run `/room all` from an account with
> no `rooms.identities` entry and the message can come back with no speaker and
> `fromSelf: true`, which the wake logic drops for every subscriber before it
> even looks at who was addressed — the message lands in the channel and wakes
> nobody. The command warns you when it cannot resolve your account, and prints
> the exact line to add. The same condition is why the
> [conversation-depth](#runaway-protection) count only resets for a speaker the
> identity layer recognises.

Agents on `wakeOn: none` are left out of both the addressee list and the "sent
to N" count. They would not hear it, and counting them would make the
confirmation a claim the command cannot back. If *every* subscriber is
`wakeOn: none`, it says so instead of posting — "nobody is here" and "everybody
is deaf" need different fixes.

`/room status` is the one that does **not** put a message in the transcript. It
wakes each agent directly rather than posting a synthetic "alex asks…" —
putting words in a person's mouth, or posting under their display name, is a
line worth not crossing. `/room all` is not that case: the words are genuinely
yours, so they appear under your name. Each answer arrives under its own name.

Slash commands register to the guild named by `channels.discord.guildId` (or
the bot's only guild), where Discord shows them immediately. Without a guild id
they go out globally, which can take up to an hour to appear — if commands seem
missing, that is almost always why.

`/room create` is the exception to "run it inside a room" — it is how the first
one gets made, so it works anywhere, and `/room` is always registered rather
than appearing only once a room exists.

### What `/room reset` actually clears

Whichever session that agent is using here — which depends on its
[session scope](#one-memory-per-room-or-one-across-them). Under `shared` there
is no such thing as forgetting one room, and the reply says so rather than
implying a precision the storage does not have. Building the key without asking
meant the command wiped an abandoned per-room session, reported *its* message
count, and left the live one untouched: it looked like it worked every time.

### `/room rewind` — the smaller version

`reset` throws the whole conversation away, which is right when it is a total
loss and wrong every other time. Most conversations that go bad go bad at a
point you can name: one misread instruction compounded over six turns, one tool
result that poisons every later answer, two agents being polite at each other
until the turn cap stops them. What you want then is to drop the tail, not the
history.

```
/room rewind agent:iris             # take back the last turn
/room rewind agent:iris turns:5     # take back five
/room rewind agent:iris turns:0     # put the last rewind back
```

A turn starts at a user message and runs until the next one, so one turn is one
thing you said plus everything the agent did about it.

**Nothing is deleted.** A rewound message keeps its row and gains a `rewound_at`
stamp; `getSessionMessages` skips stamped rows, so the model stops seeing them
while the transcript stays whole. That is what makes `turns:0` possible, and
"one turn too many" is the obvious mistake to make with a command like this.
Repeated rewinds compose, and each undo restores exactly one of them — rewinding
twice and undoing once lands you one step back, not where you started.

Because history is re-read from the database every round, a rewind takes effect
on the agent's next turn. Nothing needs restarting.

The reply quotes the opening of the first message being taken back. A rewind is
counted in turns and nobody remembers exactly how many turns ago something was
said, so the count alone gives you no way to tell a correct cut from an
off-by-one. It also reports the session scope, for the same reason `reset` does.

## Making a room

Three ways, in rough order of convenience:

```
/room create name:research purpose:Scratch space for spikes agents:researcher
```

Or ask any agent that carries the `room` tool — a DM works, provided the agent
answering your DMs has it:

> create a room called research, for research spikes, and add the researcher

Or declare it in config, which is the right home for rooms that should exist on
every deployment:

```yaml
rooms:
  rooms:
    - name: research
      ref: discord:333333333333333333
      purpose: Scratch space for research spikes.
```

Creating a channel needs Manage Channels. A room made at runtime lives in the
database, so it survives restarts without a config edit.

Subscribing at runtime takes effect immediately. The watcher listens for
`room.membership_changed` and re-arms itself, so a new `deliver: poll`
subscription gets its timer, a `checkInMinutes` gets its interval, and the
first push subscription for a backend gets its listener — without a reload.
Changes are coalesced, so a config reconcile that adds twenty subscriptions
re-arms once rather than twenty times.
### One wake queue per agent

Every trigger — a message in a room the agent watches, a poll tick, a check-in
coming due — puts the agent in a queue. An agent already waiting is not added
twice; the new room and trigger join the entry it already has.

So the queue holds at most one entry per agent, however busy the deployment is.
Ten rooms and a thousand messages produce one entry naming ten rooms, where
before they produced ten separate schedulings that knew nothing about each
other.

An entry fires at the earliest time any of its triggers asks for, so a poll tick
that is already due is not held back by a message still inside its batching
window. More traffic can only make a turn sooner, never later — resetting the
timer on every message would let a room that never goes quiet postpone a turn
indefinitely.

To put a floor under how often an agent runs:

```yaml
rooms:
  minWakeIntervalMinutes: 5   # unset by default
```

Triggers arriving inside that gap accumulate on the pending entry instead of
starting another turn, so the agent runs on a predictable cadence rather than
on demand. It is per agent and counted across every room, so there is no
per-room override — a room cannot decide how often an agent runs everywhere
else. It is also the one setting batching cannot run without, for the reason
given under [Reading several rooms in one turn](#reading-several-rooms-in-one-turn).

Note what this does and does not do. It bounds how often an agent is
*scheduled*. An entry naming ten rooms starts a turn per room unless those
rooms opted into being read together — see below.

### Reading several rooms in one turn

A subscription can ask to be read alongside the agent's other batched rooms:

```yaml
rooms:
  minWakeIntervalMinutes: 5   # required for batching, see below
  subscriptions:
    - agent: coder
      room: eng
      batch: true
    - agent: coder
      room: ops
      batch: true
```

**`minWakeIntervalMinutes` is required, not recommended.** Batching is refused
outright while it is 0, with a warning naming the agent, and the rooms keep
their own turns. The reason is arithmetic: a combined turn is charged to
whichever room holds the newest message, so the charged room *rotates*, and an
agent batching nine rooms with round-robin traffic gets 12 × 9 = 108 combined
turns an hour before any counter refuses. A feature whose purpose is lowering
wake volume would be multiplying the runaway ceiling by the batch size. The
per-agent floor is the only brake that counts an agent rather than a room, so
without one the honest answer is to refuse.

**Two is the floor.** One room with `batch: true` and nothing to batch with
keeps its own turn exactly as before, so turning the flag on in one place
changes nothing. Rooms that did not ask for it keep their own turns even when
the same wake also covers a batch.

The combined turn gets one prompt with a `## room` section per room that has
something new. Rooms with nothing new are left out entirely — an empty heading
invites an answer to a room that asked nothing. At most five messages per room,
under one hard transcript budget covering both the transcript and each section's
heading, purpose and role lines. Every room the wake policy said yes to is
guaranteed at least its newest message; whatever budget is left over goes
newest-traffic-first, so nine idle rooms cannot crowd out the room that asked a
question ten seconds ago, and the room that *caused* the wake cannot be starved
by a chattier neighbour either. A room the budget leaves out keeps its cursor, is
read on the next wake, and emits no `room.woke` — nothing of it reached the
model.

**The pause switch applies room by room.** Under the default `scope:
autonomous`, a person waiting in one room licenses a turn about *that* room: the
rooms holding nothing but agent-to-agent traffic are dropped from the batch
before the prompt is built, keeping their cursors. Judged over the batch as a
whole it would be the other way round — one human anywhere would un-pause every
room the agent watches and invite it to post in all of them, which is the exact
runaway the switch exists for. Under `scope: all` nothing runs.

Posting is explicit, because a turn covering several rooms has no default
destination:

```
room(action="post", room="eng", body="bounded backoff, capped at five")
room(action="pass")     # no room: stay quiet in all of them
```

Text that names no room gets one correction round naming the rooms and asking
which; text that still names none is dropped with a log line rather than posted
somewhere plausible. Single-room wakes keep their forgiving behaviour, where the
reply goes to the one room it could have been for.

Two triggers stay outside the batch. A **scheduled check-in** keeps its own
turn, because it is a different kind of prompt — nobody said anything, and a
digest that only runs when something is new would swallow it in exactly the
quiet rooms it exists for. And a **poll tick** over a batch where nothing
deserves a wake runs nothing at all: poll timers fire whether or not anything
happened, so without that check batching would raise wake volume rather than
lower it. The traffic is still there next time, and is the context for whatever
finally does wake the agent.

Two more things worth knowing before turning this on:

- **The wake budget.** A combined turn charges one wake, against the room whose
  newest message is most recent. The hourly ceiling is a per-`(agent, room)`
  counter and cannot express "this agent ran once", so for a batching deployment
  `minWakeIntervalMinutes` is the throttle that actually binds — which is why
  batching will not run without it — and the hourly ceiling is a backstop that
  only sees the primary room.
- **The anti-chatter brake.** A batched turn that used a tool clears
  `agent_turns` only in the rooms it actually posted to. The counter belongs to
  one room's conversation, so work done in one room is no reason to release the
  brake in another where two agents are looping.
- **The session.** A combined turn uses the shared session key
  (`room:all:<agent>`), because filing a cross-room conversation under whichever
  room happened to be primary would hide it from the next wake with a different
  primary. An agent that batches is effectively `roomSessionScope: shared`.

### Taking turns

When one message names two agents, both are woken. By default they now run
**one at a time**, in the order they were triggered:

```yaml
rooms:
  turnTaking: serial      # default; `concurrent` restores the old behaviour
  rooms:
    - name: eng
      ref: discord:1234567890123456789
      turnTaking: concurrent   # per-room override
```

The point is not tidiness, it is context. A wake fetches the room's backlog
when it *starts*, not when it was triggered — so chaining is enough to put the
first agent's reply into the second agent's prompt, with no change to the
prompt itself. Under `concurrent` both prompts are built from the message
alone and each agent answers as though it were the only one asked.

Serialization is per room. Two rooms still run in parallel, and an agent that
is slow in one room does not hold up another. Within a room it does mean the
second agent waits for the first, so a hung model turn delays the others until
the loop's own timeout fires.

`/room status` is deliberately exempt: it is a person asking everyone at once,
and it answers immediately rather than queueing behind whatever the room is
already doing.

## The `room` tool

One tool, several actions. Agents need `room` in their `tools:` list.

| action | what it does |
|---|---|
| `list` | rooms it can see, and whether it is subscribed |
| `read` | messages since its cursor — omit `room` to sweep every room it watches (reading advances the cursor) |
| `post` | say something; `to` addresses participants |
| `dm` | message one agent directly, no room involved |
| `pass` | say nothing this turn |
| `update` | replace a message you already posted, by `message_id` |
| `react` | acknowledge with an emoji instead of a message |
| `create` | open a new room |
| `invite` | add a participant — agents subscribe, humans get transport access |
| `remove` | drop a participant |
| `purpose` | read what the room is for, or set it by passing `purpose` |
| `members` | who is in the room |
| `subscribe` / `unsubscribe` | control whether the room wakes it |

The tool registers whenever a database exists, **not** only when a transport is
connected — during a Discord outage it reports "no backend connected", which is
a recoverable state rather than a silently absent tool.

### Messaging an agent without a room

`dm` hands the message straight to the recipient and returns its reply. The
exchange lands in the recipient's session, so it is durable and inspectable — it
just is not a *place*.

```
room(action="dm", to="executive-assistant", body="Trip moved to Aug 3.")
```

It used to open a channel per recipient, which at 27 agents is 27 channels
waiting to happen. Shared sessions removed the room's second job — `room:all:<agent>`
does not reference a room — so materialising one to carry a single message was
pure overhead.

Mirror a particular agent's direct line into a channel you want to read:

```yaml
rooms:
  desks:
    executive-assistant: executive
```

Two caveats. It is **synchronous** — the sender waits for the recipient's model
run, which suits a question and not a broadcast. And agent-to-agent DMs are not
in Discord, so they cannot be audited by scrolling; they are in the `messages`
table.

## Backends

`RoomBackend` is the seam. A backend is usually a capability of a live transport
(`Channel.rooms`), discovered through the registry rather than constructed:

```ts
export interface RoomBackend {
  readonly id: string;
  readonly capabilities: RoomCapabilities;   // create / members / push / history
  listRooms(): Promise<Room[]>;
  getRoom(id: string): Promise<Room | null>;
  post(id: string, message: OutboundRoomMessage): Promise<RoomMessage | null>;
  fetchSince(id: string, cursor: string | null, limit: number): Promise<RoomMessage[]>;
  createRoom?(opts: CreateRoomOptions): Promise<Room>;
  listMembers?(id: string): Promise<RoomMember[]>;
  addMember?(id: string, memberId: string): Promise<void>;
  onMessage?(handler: (message: RoomMessage) => void): () => void;
}
```

Callers feature-detect through `capabilities` rather than duck-typing methods,
so an unsupported action produces a clear message instead of a `TypeError`.

Two ship in the box:

**`local`** — pure SQLite, no network. Rooms work and are testable before any
transport is configured, and it gives agents somewhere to talk that does not
post to a real server. Registered when the runtime is constructed.

**`discord`** — registered when the gateway reaches `ClientReady` (its room list
reads the guild channel cache, which is empty before that) and unregistered on
disconnect. Notable constraints:

- **No privileged intents.** Membership is derived from channel permission
  overwrites, not `guild.members.fetch`, so you never have to enable the
  `GuildMembers` intent. A *public* channel has no member overwrites, so
  `listMembers` returns an empty list — that means "unknown", not "nobody".
- **Cursors are zero-padded snowflakes.** Snowflake ids grow in digit count, so
  raw string comparison breaks across boundaries: `"950…"` sorts after
  `"1046…"`. Padding to 20 digits makes lexical order match send order, which
  is what the cursor comparison in SQL relies on.
- `channels.discord.guildId` picks the guild for room creation. Only needed when
  the bot is in more than one.
- **Creating rooms needs Manage Channels**, per-agent identity needs **Manage
  Webhooks**, and reading history needs Read Message History. None is a
  privileged intent; all are ordinary channel permissions granted at invite
  time. Missing Manage Webhooks costs you distinct participants, nothing else —
  the backend falls back to text prefixes and says so once in the log.

### Writing a backend

Register it when your transport connects and remove it when it goes away:

```ts
import { registerRoomBackend, unregisterRoomBackend } from "@tailored-ai/core";

registerRoomBackend(new MyRoomBackend(client));
// on disconnect:
unregisterRoomBackend("mytransport");
```

Room refs are stored in SQLite and outlive connections, so "backend not
connected" is a normal runtime state rather than a bug — the registry's error
names what *is* available.

Cursors must be opaque but **lexically orderable in send order**, because the
store compares them as strings in SQL. Zero-pad counters and snowflakes.

## Events

Plugins observe room traffic through the runtime event bus:

| event | when |
|---|---|
| `room.message` | any message lands, before any wake decision — including traffic nobody wakes on |
| `room.woke` | a wake actually consumed budget and started a run |
| `room.membership_changed` | an agent took or gave up a seat — see [Announcing who is here](#announcing-who-is-here) |

This is the seam for behavior core deliberately does not implement: routing
rules, custom escalation, mirroring a room elsewhere.

`room.membership_changed` fires only for changes that actually happened: a
re-subscribe that changed nothing is not a join, and unsubscribing an agent that
was not there is not a leave. Its `source` says whether the change came from
`config` or from an agent, which matters because config-declared subscriptions
are re-applied on every reconcile.

## Announcing who is here

`builtin:room-announcer` posts a line in the room when an agent joins or leaves
it:

```
room  **channel-manager** created this room and joined it.
room  **iris** joined this room.
room  **channel-manager** left this room.
```

It is on by default. Membership was previously something you could only find out
by asking — `/room members` told you, and nothing else did. An agent that
created a room stayed subscribed to it, because creating a room subscribes you,
and went on receiving everything said there long afterwards. Nothing had ever
suggested there was anything to look for.

The creator's own join gets its own sentence, because it is a side effect of
opening the room rather than a decision anyone made about who should be in it —
and it is the case that went unnoticed.

**Config-declared subscriptions are never announced.** `rooms.subscriptions` is
re-applied on every reconcile and re-created wholesale on a fresh database, so
announcing those would post a wall of joins on every boot — which is how a
signal meant to make membership visible would instead teach everyone to skip it.

```yaml
plugins:
  - module: builtin:room-announcer
    config:
      speaker: room             # identity the line is posted under
      creationWindowSeconds: 10 # creator join still reads as "created it" within this
      announceJoins: true
      announceLeaves: true
```

Announcing is a workflow opinion, so it is a plugin rather than a property of
rooms: core emits `room.membership_changed`, and a deployment that wants
different wording, a different destination or nothing at all sets
`enabled: false` and subscribes its own handler.

## Reading direct messages

An agent can message another directly — `room(action="dm")`, and `delegate` when
it hands a finished task back. That is not a room, so it leaves no transcript:
before `builtin:dm-mirror` the only evidence was a session row you had to
already suspect existed to go looking for.

`deliverAgentMessage` emits **`agent.messaged`** once per exchange, after the
recipient's loop returns, so one event carries the message and its reply
together rather than two half-facts to correlate. `via` says which surface
produced it — `dm` or `delegate`. A delivery that throws emits nothing, so a
subscriber counting these counts conversations rather than attempts.

`builtin:dm-mirror` turns that into a line in a room:

```
dm  **coder → nova**
    are you free tonight?

    **nova replied**
    yes, after eight
```

**It is off by default**, unlike the announcer. A mirror copies traffic that is
private by default into a place other people read, which should be a decision
somebody made out loud rather than something a version bump switches on.

```yaml
plugins:
  - module: builtin:dm-mirror
    enabled: true
    config:
      room: dm-log        # required — name or <backend>:<id>
      via: [dm]           # add "delegate" to include task handoff
      agents: []          # empty mirrors everyone
      maxBodyChars: 500   # per side, message and reply
      speaker: dm
```

### The loop it must not create

A mirror that wakes an agent is a machine for making its own input: the line
lands in the room, the room wakes an agent, the agent answers, something
delivers a message, and the mirror posts again. Two guards, because one is not
enough:

- **It posts with no `to`**, so nobody is addressed and a `wakeOn: "named"`
  watcher does not wake.
- **It refuses to run** when the target room has any subscriber whose `wakeOn`
  is not `"none"` — `wakeOn: "all"` wakes on an unaddressed line too, so the
  first guard does not cover it. The refusal names the subscription that caused
  it and is re-checked on every reload, because an agent can subscribe *itself*
  to a room at runtime and turn a safe configuration into a loop with no config
  edit.

So the mirror room wants either no subscribers at all or only `wakeOn: none`
readers. Refusing is loud and reversible; a loop is neither.

## Confining an agent to its files

`tools.write.allowedPaths` is deployment-wide, so granting an agent `write`
otherwise grants it the whole filesystem — and an agent that reads web pages is
an agent that can be talked into writing things. `fileBoundary` pins one agent
to one directory:

```yaml
agents:
  travel-coordinator:
    tools: [read, write, edit, documents, recall]
    fileBoundary: ~/research/travel
```

File and exec tools then reject any path resolving outside it — the same
enforcement the task watcher uses to pin coder/reviewer to their worktree, just
declared instead of injected. A leading `~` is expanded.

## Acknowledging without speaking

"Got it" costs a turn: it wakes whoever is watching and pushes the room toward
its depth cap, for no information. A reaction says the same thing at none of
that cost:

```
room(action="react", room="eng", message_id="1531…", emoji="✅")
```

This is the cheapest answer to rooms filling with politeness — it removes the
reason to speak, where `maxAgentTurns` only caps how often agents may.

## Saying it again vs changing what you said

Rooms were append-only, so a recurring status posted a new message every time —
an agent checking in hourly was an hourly notification whether or not anything
had changed. `post` now returns a message id, and `update` replaces that
message:

```
room(action="post",   room="trip", body="status: waiting on 2 bookings")
  -> Posted to "trip". Message id: 1531…

room(action="update", room="trip", message_id="1531…", body="status: all booked")
```

One message that changes, rather than five that accumulate. `capabilities.edit`
says whether a transport can do it; Discord edits through the webhook that
posted, since the bot cannot edit a webhook's message any other way.

## Seeing what an agent did

A message can name a **parent**, and a transport that can nest renders it —
Discord opens a thread on the parent. The seam says "this message belongs under
that one", not "make a thread", so a transport that nests differently, or not at
all, is not forced into Discord's shape. `capabilities.threads` says which.

The record opens with **why the agent woke** — named directly, a person asked
the room, watching everything, or a scheduled check-in. Wake policy is where
most room misbehaviour starts, and it was previously invisible.

Turn it on to attach an agent's tool calls under its reply:

```yaml
rooms:
  toolActivity: all      # none (default) | mutations | all
```

```
travel-coordinator  Fixed. Replaced the 3 hallucinated bars…
  └ details
      • woke: named directly
      • `read` /home/q/trip/sd_bars_verified.md
      • `read` /home/q/trip/sd_tiki_investigation.md
      • `edit` /home/q/trip/itinerary_bar_focused.md
```

The room still reads as conversation; the record is one click away. `mutations`
shows only calls that changed something, which is quieter — but reads are where
a wrong answer usually comes from. An agent that read the document contradicting
its own output is only visible if you can see the read.

Each line names the tool and the argument identifying its target. Never the full
arguments: those carry file contents and search bodies, and a channel is the
wrong place for them.

## Errors as a room

`builtin:error-room` forwards runtime errors into a room, so failures land in
front of an agent instead of in a log nobody reads.

```yaml
plugins:
  - module: builtin:error-room
    config:
      room: errors
      notify: generalist      # addressed, so a "named" subscriber wakes
      levels: [error]
      batchSeconds: 30
      maxPerHour: 6
      maxPerReport: 5
      ignore: [ECONNREFUSED, DEPRECATION]
```

Give the room a purpose that says what triage means for you, subscribe an
agent, and errors get diagnosed rather than accumulated:

```
log         @generalist • [cron] "collection-scanner" aborted — beforeRun hook
                          "gmail" returned an error: oauth2: "invalid_grant"

generalist  @log **Diagnosis: expired/revoked Gmail OAuth2 token.** The stored
            credentials for the gmail tool are rejected before the query runs…
```

It reports; it does not fix. What to do about an error is the reading agent's
job, which is prompt and config.

Three failure modes are designed against, because each is worse than the
problem it solves:

- **Reporting an error must not cause an error.** Posting can fail, and that
  failure gets logged, which would be posted... A re-entrancy flag means
  nothing logged while reporting is ever reported.
- **A flood must not reach Discord.** One broken poller once produced ~100k
  `ECONNREFUSED` lines. Identical errors collapse to one entry with a count,
  batches post on an interval, and past `maxPerHour` the room is told only how
  many were withheld.
- **Secrets must not be posted.** A token in a channel is a token you rotate.
  Anything credential-shaped is redacted before it leaves the process.

## Storage

| table | holds |
|---|---|
| `rooms` | the name → `<backend>:<id>` directory |
| `room_subscriptions` | who watches what, their cursor, and their hourly wake budget — a row appearing or disappearing emits `room.membership_changed` |
| `room_messages` | message storage for the `local` backend only |
| `room_members` | `local` membership, plus a cache of transport-side membership |

Room state lives in SQLite rather than `config.yaml` deliberately:
`ChannelLifecycleManager` restarts a transport whenever its config block
changes, so writing a newly-created room into `channels.discord.*` would drop
and reconnect the Discord gateway every time an agent opened a room.

## Reference

```yaml
rooms:
  enabled: true                 # master switch for the watcher; rooms stay readable either way
  ownerLabel: owner             # label for the implicit owner identity
  defaultBackend: discord       # used when an agent creates a room without naming one
  maxWakesPerHour: 12           # per-room override available on each rooms[] entry
  maxAgentTurns: 6              # agent-only turns before the room goes quiet
  maxBacklog: 30                # most messages handed to an agent in one wake
  batchSeconds: 3
  defaultPollSeconds: 900
  urgencyWindowHours: { high: 0.25, medium: 24, low: 168 }
  identities: {}
  desks: {}                     # agent -> room, to mirror its direct line
  rooms: []
  subscriptions: []
```

## Related

- [Notifications](./notifications.md) — the repeat-suppression gate rooms reuse
- [Agents and hooks](./agents-and-hooks.md) — named agents, delegation, hooks
- [Architecture](./architecture.md) — registries and the runtime
