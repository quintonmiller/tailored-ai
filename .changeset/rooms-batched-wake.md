---
"@tailored-ai/core": patch
---

One wake can now read several rooms in a single turn, when the subscriptions ask for it.

The queue has produced one entry per agent since #348, but each room named in that entry still started a turn of its own: an agent watching nine rooms ran nine model turns, each blind to the other eight and each costing a wake. A person with nine channels open does not get interrupted nine times.

Opt in per subscription, and set the per-agent floor it requires:

```yaml
rooms:
  minWakeIntervalMinutes: 5   # required — batching is refused without it
  subscriptions:
    - agent: coder
      room: eng
      batch: true
    - agent: coder
      room: ops
      batch: true
```

`rooms.minWakeIntervalMinutes` is a requirement, not a recommendation. While it is 0, an agent's `batch: true` rooms keep their own turns and a warning says why, once per agent. A combined turn is charged to whichever room holds the newest message, so the charged room *rotates*: nine batched rooms with round-robin traffic buy 12 × 9 = 108 combined turns an hour before any counter refuses. A feature meant to lower wake volume would instead be multiplying the runaway ceiling by the batch size, and the per-agent floor is the only brake that counts an agent rather than a room. Refusing is the honest failure; silently raising the ceiling is not.

Two is the floor for rooms as well. One room with `batch: true` and nothing to batch with keeps today's per-room turn exactly, so a deployment that sets the flag in one place sees no change at all, and a deployment that sets it nowhere sees none either. The existing suite is the proof: it passes unedited.

What a combined turn does differently:

- **One prompt**, a `## room` section per room that has something new, rooms with nothing new omitted entirely. At most five messages per room, under one hard budget that charges each section's heading, purpose and role as well as its transcript. Every room the wake policy said yes to is guaranteed its newest message before the remainder is allocated newest-traffic-first, so nine idle rooms cannot crowd out the one that asked a question ten seconds ago — and the room that *caused* the wake cannot be starved by a chattier neighbour either.
- **One wake charged**, against the room whose newest message is most recent, rather than one per room. The hourly ceiling is an UPDATE on an `(agent, room)` row and cannot express "this agent ran once", which is exactly why `minWakeIntervalMinutes` is required; the hourly one stays as a backstop.
- **The pause switch applied room by room.** Under `scope: autonomous` a person waiting in one room licenses a turn about that room, and the rooms carrying nothing but agent-to-agent traffic are dropped before the prompt is built. Asked over the whole batch, one human anywhere would un-pause every room the agent watches and invite it to post in all of them — the runaway the switch exists for, arriving through the feature meant to reduce wakes.
- **Room queues acquired in one agreed order.** Each per-room chain from #332 is a lock, and a turn spanning N rooms holds all N — two agents with overlapping batches taking them in different orders is a deadlock. One comparator, in one place, with a test that deadlocks without it.
- **Every shown room's cursor advances**, keeping the existing rule that a cursor records what was shown rather than what was acted on. A room the budget squeezed out was never shown, so it keeps its cursor, emits no `room.woke`, and is read next time.
- **`agent_turns` cleared only where the agent posted.** The anti-chatter counter belongs to one room's conversation, so a tool call in one room is no reason to release the brake in another where two agents are looping.
- **A shared session**, because a per-room session key would file a cross-room conversation under whichever room happened to be primary.

Two triggers deliberately stay outside a batch. A scheduled check-in keeps its own turn — it is a different kind of prompt, and a digest that only runs when something is new would swallow it in the quiet rooms it exists for. And a poll tick over a batch where nothing deserves a wake runs nothing: poll timers fire regardless of traffic, so without that check batching would raise wake volume rather than lower it.

Reply routing is the honest part. A combined turn has no single destination, so bare text is not posted anywhere: the agent gets one correction round naming the rooms in play and asking which, and text that still names no room is dropped with a log line. Every correction a batched turn can give says the same thing — name a room or pass — including the ones for malformed output, which a single-room turn answers by asking for plain text. A plausible message in the wrong channel is worse than a visible failure. Single-room wakes keep today's forgiving behaviour untouched.

Step 3 of 3 toward #344.
