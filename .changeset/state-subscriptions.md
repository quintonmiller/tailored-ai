---
"@tailored-ai/core": patch
"@tailored-ai/cli": patch
---

Subscriptions: wake an agent on any runtime event, on a schedule of its choosing.

Rooms decide when a message wakes an agent. Nothing did the same for
everything else on the bus — a world-state change, a new task — so an agent
found out about a change only when something else happened to wake it.

`subscriptions:` names an agent, an event and a `when` match (the `hooks.on`
matcher), and how to deliver it:

- `immediate`, a turn now; `queue`, after the rooms' batching delay; `batch`,
  one `window` after the first event; `digest`, on an `every` schedule; or
  `record`, no turn of its own but shown under "Since your last turn" in the
  agent's next one.
- `target: session` runs the turn in the agent's own session; `target: { room }`
  runs it in a room, through the room's turn order and hourly ceiling.
- Events are described in one line when they happen, so a digest still says
  what changed at the time.
- Pending events are stored, so a restart re-arms every batch and digest; a
  delivery refused by a ceiling or a pause is retried for up to an hour.
- An agent is not told about its own changes unless it sets `includeOwn`.
- `validateConfig` names a subscription that would never deliver: an unknown
  agent, an event nothing emits (with the nearest real one by edit distance),
  a batch with no window, a digest with no schedule.
