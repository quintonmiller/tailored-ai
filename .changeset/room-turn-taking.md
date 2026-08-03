---
"@tailored-ai/core": patch
---

Agents woken by the same message take turns.

A message naming two agents woke both, and both were dispatched without being awaited — the in-flight guard is keyed per (agent, room), so nothing serialized them. They answered the same question in parallel, and each prompt was built from the backlog as it stood when the message landed, so neither knew the other had been asked. Two overlapping answers to one question is the most common way a room becomes unreadable, and the conversation-depth cap cannot help because both replies are legitimately addressed.

Wakes now queue on a FIFO chain per room. The payoff comes from something that was already true: `runWake` fetches the backlog when it *starts*, not when the trigger was queued. So chaining alone is enough to put the first agent's reply into the second agent's prompt — the prompt builder is untouched.

Serialization is per room, not global: two rooms still run in parallel, and an agent slow in one room does not hold up another. Within a room the second agent does wait for the first, so a hung model turn delays the others until the loop's own timeout fires. That is the cost, and it is why the behaviour is selectable — `rooms.turnTaking: "serial" | "concurrent"`, with a per-room override, defaulting to `serial`.

A repeat trigger for an agent already waiting its turn is now dropped rather than queued twice. The queued run re-reads the backlog when it starts, so it sees the newer message anyway — which also stops `wakeOn: "all"` waking an agent a second time for a reply that arrived while it was still in the queue.

Every path that starts a turn for a room goes through the queue — the push debounce, a poll tick, and a scheduled check-in. Turn-taking that covered only the push path would have left the other two racing exactly as before, since both reached their runners directly.

`/room status` is deliberately left off the chain. It is a person asking every agent at once and answers immediately, which is the reason it was written not to await in the first place.
