---
"@tailored-ai/core": patch
---

Rooms announce who joined and who left, so membership stops being invisible.

An agent called `channel-manager` opened a room described as "Private 1-on-1
between Kiki and Quinton", stayed subscribed to it because
`room(action="create")` subscribes the creator, and read nine hours of that
conversation across seventy wake prompts. `/room members` would have shown it
the whole time. Nobody looked, because nothing had ever suggested there was
anything to see. Being in a room and looking like you are in a room were
different facts.

- **`room.membership_changed`** on the runtime event bus — `{ roomRef, agent,
  change: "joined" | "left", source: "config" | "agent" }`. Emitted by
  `RoomStore` only for changes that actually happened: a re-subscribe that
  changed nothing is not a join, and unsubscribing an agent that was not there
  is not a leave. The store takes the bus as an optional constructor argument,
  so bare constructions keep working.
- **`builtin:room-announcer`**, on by default, posts one line into the affected
  room: `**kiki** joined this room.` / `**kiki** left this room.` The creator's
  own join gets its own sentence — `**channel-manager** created this room and
  joined it.` — because it is a side effect of opening the room rather than a
  decision about who should be in it, and it is the case that went unnoticed.

`source: "config"` changes are suppressed outright. `rooms.subscriptions` is
re-applied on every reconcile and re-created wholesale on a fresh database, so
announcing those would post a wall of joins on every boot — the way a signal
meant to make membership visible becomes noise everyone learns to skip.

Announcing is a workflow opinion, so it is a removable plugin rather than a
property of rooms: core emits the event, and a deployment that wants different
wording or none of it sets `enabled: false`. Config: `{ module:
"builtin:room-announcer", config: { speaker, creationWindowSeconds,
announceJoins, announceLeaves } }`.
