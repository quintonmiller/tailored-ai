---
"@tailored-ai/core": patch
---

One place decides when an agent is due to run.

Three things start a room turn — a message arrives, a poll tick fires, a scheduled check-in comes due — and each owned its own timing and its own idea of "already handled". The message path debounced on `${agent} ${roomRef}`; the other two had no coalescing at all and leaned on the in-flight guard further down to sort out overlaps. Nothing could answer "is this agent already due, and why", which is the question everything about wake volume turns on.

`WakeQueue` owns that and nothing else. It decides whether an agent is due and when; what runs when an entry comes due stays with the caller, so the poll path still filters its backlog and the check-in path still builds its own prompt.

Behaviour is unchanged. The message path keeps its `batchSeconds` debounce, poll and check-in are still due the moment their interval fires, and the existing suite pins it.

This is the first of three steps toward #344. Entry identity lives in one function, `queueKey`, and is per (agent, room, trigger) — exactly what the code did before. Making a wake per-agent, so an agent with ten busy rooms is due once rather than ten times, is a change to that function and to how entries merge, not a change to any caller. That is the whole point of doing this separately and first.
