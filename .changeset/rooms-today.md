---
"@tailored-ai/core": patch
---

Rooms: tell agents what day it is.

Rooms are time-situated — check-ins fire on a clock, purposes carry dates,
agents are asked how long until something — but an agent only knows the date if
it happens to carry a clock tool, and most do not. It infers instead, and gets
it wrong: a coordinator running a trip on an hourly check-in said "two days out"
when it was one, and had the departure date wrong until corrected by hand.

Every room prompt now opens with the current date. Ten tokens, no tool call,
every agent. (#277)
