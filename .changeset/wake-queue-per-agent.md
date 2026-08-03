---
"@tailored-ai/core": patch
---

An agent is one entry in the wake queue, however many of its rooms are busy.

The queue was keyed per (agent, room, trigger) — which is what every wake path did independently before the queue existed. So an agent watching ten rooms was scheduled ten times over, each scheduling knowing nothing about the other nine, and wake volume scaled with traffic rather than with the number of agents.

Entry identity is now the agent. Enqueueing one that is already waiting merges the new room and trigger into its existing entry, so ten rooms and a thousand messages produce one entry naming ten rooms. The queue's length is bounded by agent count and never by how much arrives.

Two merge rules worth knowing:

- An entry fires at the earliest time any of its triggers asks for, so a poll tick that is already due is not held back by a message still inside its batching window.
- More traffic can only make a turn **sooner**, never later. This is deliberately not a debounce reset: an agent in a room that never goes quiet would have its turn postponed indefinitely, which is starvation the old per-room debounce could produce.

New `rooms.minWakeIntervalMinutes`, unset by default. It is the shortest gap between one agent's wakes, counted across every room it watches; triggers arriving inside the gap accumulate on the pending entry rather than starting another turn. Per agent and therefore no per-room override — a room does not get to decide how often an agent runs everywhere else.

Be clear about the scope: this bounds how often an agent is *scheduled*. An entry naming ten rooms still starts a turn per room. Turning one due entry into one turn that reads every room at once is a change to the caller, with its own prompt, cursor and reply-routing decisions, and lands separately.

Step 2 of 3 toward #344.
