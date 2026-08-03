---
"@tailored-ai/core": patch
---

Subscribing an agent to a room at runtime now actually starts it watching.

The watcher armed its timers and listeners once, from whatever subscriptions existed when `start()` ran. Anything added afterwards — `/room add`, the room tool's `invite`, a config reconcile — was written to the database and then never armed. A new `deliver: poll` subscription had no poll timer, a `checkInMinutes` had no interval, and the first push subscription for a backend had no message listener.

Nothing reported an error. The write succeeded, the subscription was really there, `/room members` listed it, and the agent simply never spoke. From the outside that reads as a model too weak to answer, which is the wrong diagnosis and leads to the wrong fix.

`RoomStore` already emitted `room.membership_changed` on subscribe and unsubscribe — the announcer plugin has been consuming it all along. The watcher only ever emitted events and never listened to any. It now subscribes to that one and re-arms.

Re-arms are debounced, because a config reconcile emits one event per subscription it adds or prunes and an agent can invite several peers in one turn; without coalescing, twenty subscriptions would tear down and rebuild every timer in the deployment twenty times.

The tradeoff that leaves: `rearm()` rebuilds *all* timers, so any poll or check-in clock in flight restarts. A subscription changing every few minutes could keep starving a long poll interval. Arming incrementally — touching only what changed — avoids that and is the better end state; this is the version that makes the documented feature work at all, and never firing is worse than firing late.

Also fixes a contradiction: `/room add` reported "Takes effect immediately" while the `room` tool reported "Takes effect on the next reload" for the same write. The first was false and is now true; both say the same thing.
