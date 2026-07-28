---
"@tailored-ai/core": patch
"@tailored-ai/cli": patch
---

Add rooms: shared multi-party conversations for agents and humans.

A room is a named destination within a transport (a Discord channel) that
several agents and people share, distinct from a `channel` (the transport
itself) and a `session` (one participant's private history).

- `RoomBackend` seam with a `local` (SQLite) and a `discord` implementation;
  backends register when a transport connects and unregister when it drops.
- Addressing is `@name`; a participant with a Discord account is written as a
  real `<@id>` mention so they are actually notified, with `allowedMentions`
  allowlisting only the accounts a message addressed. Agents, having no
  account, stay plain text.
- On Discord each agent posts through a channel webhook, so it appears as its
  own participant with its own name and avatar. Speaker envelopes
  (`[supervisor] @coder …`) remain the fallback where a transport has no such
  concept, so one bot account can still carry several identities. The speaker is stamped by core from the calling
  agent, never from model output, and is only trusted on messages from TAI's
  own account — a prefix typed by anyone else cannot impersonate an agent.
- Exactly one agent hosts a room: the creator gets `addressed`, invitees get
  `named`, so a loose message gets one answer instead of one per agent.
- Subscriptions with two independent axes: `deliver` (push/poll) decides when
  an agent looks, `wakeOn` (named/addressed/all/none) decides what makes it run.
  `named` keeps a room of several agents from all answering one loose question.
- Runaway protection: an agent never wakes on its own message, an atomically
  consumed per-(agent, room) hourly wake ceiling, and burst debouncing. Wakes
  refused mid-run or by the ceiling are re-armed rather than dropped, and the
  watcher drains each backlog once on startup. A `maxAgentTurns` depth cap
  stops two agents being politely stuck at each other, which no single-message
  rule can detect. Reset by a human speaking, and by any turn that used a tool
  — collaboration looks identical to politeness, and tool use is what tells
  them apart, so agents working on a task are not silenced mid-task. A turn is
  a contiguous run from one speaker, so a long reply split across transport
  messages counts once rather than three times.
- Posts reuse the NotificationGate with a window scaled by `urgency`
  (high ~15min, medium ~daily, low ~weekly). Replies to a direct address are
  exempt.
- Each room has a `purpose` — standing instructions injected into every wake
  prompt and mirrored to the Discord channel topic so people see them too.
- `/room` slash commands (create, ping, members, add, remove, purpose, status);
  `ping` autocompletes the agents in the room, so addressing never has to be
  guessed, and a misspelt `@name` is corrected when exactly one identity is
  close enough — otherwise a typo silently routes the message to the room host. A name is a call-out anywhere in a message, not just at the front. to manage a
  room from inside Discord. `/room status` asks every agent what it is working
  on by waking each directly, rather than faking a message from the person.
- `room` tool (list/read/post/pass/create/invite/remove/members/purpose/subscribe/unsubscribe),
  where `pass` lets an agent decline to speak — without it, being woken
  guarantees a message and rooms fill with "Acknowledged." — and
  `room.message` / `room.woke` events for plugin-side behavior.

Also adds `NotificationCandidate.windowHours` so any caller can scale repeat
suppression per message rather than only per config.
