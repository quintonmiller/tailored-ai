---
"@tailored-ai/core": patch
---

A check-in charges one wake against `maxWakesPerHour`, not two.

`runCheckIn` called `tryConsumeWake` as a cheap pre-flight and then handed off to
`runPrompted`, which calls it again — so every check-in spent two of the hourly
allowance. A check that spends the thing it is checking is not a pre-flight.

The effect was invisible and the arithmetic misleading: a room budgeted for one
hourly check-in plus eleven turns of real conversation actually got one check-in
plus ten, and an operator setting the number was wrong by however many of the
wakes were check-ins.

`runPrompted` is the shared gate every prompted turn passes through and is now
the only place the charge happens, which is what `runScheduledWake` already
relied on.
