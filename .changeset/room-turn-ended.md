---
"@tailored-ai/core": patch
---

Room turns now report why they ended, on a new `room.turn_ended` event.

Every other place that runs an agent loop asks it why it stopped. The task
watcher does, and routes a stall to `StallGuard`. The exploratory worker does.
The room watcher did not, and a stalled room turn was therefore a fact that
existed nowhere: the loop gets one tools-withheld call so it can explain itself,
so it returns ordinary prose, and in a room that prose is posted like any other
message. Measured on a 237-run benchmark cohort, all 12 stalls came back as
prose and not one carried an `[Agent stopped: …]` marker — so anything matching
that string was matching nothing.

`room.turn_ended` fires for every turn, including one that ended by throwing,
and carries the structured `LoopStop`, the rooms it covered, why the agent woke,
whether anything was posted, and a short `stallReason` when it got stuck. A
stall also logs a warning naming the agent and the room. What to do about it —
retry, mark the message, say so in the room — stays a plugin's opinion, the way
`agent.stalled` leaves it to `StallGuard`.
