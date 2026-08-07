---
"@tailored-ai/core": patch
"@tailored-ai/cli": patch
---

Core: let an agent wake itself (`schedule` tool + `ScheduleRunner`)

Everything that could start a turn was authored by somebody else — cron jobs and
room check-ins by the operator in `config.yaml`, message and poll wakes by
traffic. So an agent that said "I'll check back after the deploy" was describing
something no part of the system would do. The nearest workaround,
`admin(action=update_config, path='cron.jobs')`, is a global operator config
write with no per-agent scope, no limits, no one-shot support, and it bounces the
cron scheduler on reload. `cron/schedule-dsl.ts` has said since it was written
that one-shot timestamps are out of scope there and tracked separately; this is
that.

**The tool.** One tool, four actions, following the `room` / `tasks` convention:

```
schedule(action="once",   when="10 minutes" | "2026-08-08 10:00" | "tomorrow 9am", note="…")
schedule(action="repeat", every="weekdays at 9am" | "every 2 hours", note="…", starts=…, until=…)
schedule(action="list")
schedule(action="cancel", id="a3f1" | "a3f1,b7c2" | all=true)
```

Every accepted booking echoes back the absolute time it resolved to, which is
worth more than any amount of parser cleverness: a model that meant tomorrow and
got today finds out in the same turn, while it can still fix it. A rejected call
answers with the grammar it wanted, because error text is the only documentation
a model reliably reads. A bare number is refused rather than guessed — "10" reads
equally as ten minutes and ten o'clock.

Recurrences reuse `compileSchedule` verbatim, so the phrases an operator learns
in `config.yaml` work at runtime too. Plain intervals ("every 2 hours", "every 3
days") are stored as elapsed time anchored to the start instead, because cron
cannot express phase: `every 2 hours` compiled to cron fires on even hours and
silently discards the start minute, which is not what an agent asking at 10:15
meant. Cron also cannot say "every 3 days" at all.

**Firing.** One poll tick over an indexed `next_run_at`, not a timer per
schedule. `setInterval` drifts and survives neither a restart nor a suspend nor a
clock jump; a due time in the database survives all three, and a wake missed
while the service was down fires on the next tick rather than evaporating. The
row is claimed — advanced out of the due set — *before* the turn starts, so a
turn that outlasts several ticks cannot be re-fired underneath itself. Delivery
is at-most-once, which is the right side to fail on. A recurrence advances
strictly past now, so three hours of downtime costs one wake rather than three.

**Where a wake lands.** The room the turn was woken for, read from the working
memory the `room` tool already uses to scope `pass`; several rooms is a question
rather than a guess; no room falls back to the session. A room wake runs through
the new `RoomWatcher.runScheduledWake`, which shares `runCheckIn`'s tail, so it
inherits the per-room turn chain, `maxWakesPerHour`, the silence refund, `pass`
and repeat suppression — a self-booked wake is not a way around the deployment's
brakes. It is deliberately not routed through the `WakeQueue`: collapsing it into
a concurrent message wake would drop the note, and the note is the wake.

**Limits**, under a new top-level `schedules` block: `maxPerAgent` (20),
`minIntervalMinutes` (15), `maxHorizonDays` (365), `maxDeferrals` (3),
`tickSeconds` (30). The brake on a recurrence the agent has forgotten about is
not an expiry timer it never sees — every occurrence names its own id and run
count and says how to cancel itself. A pause skips recurring occurrences but
leaves one-shots due, so a commitment survives a pause and a heartbeat does not
need to.

Also here: `ScheduleStore.listDue` takes the time from its caller rather than
using `datetime('now')`, so the runner's injected clock is the only clock and the
timing rules are testable without waiting; `parseTime` and `DEFAULT_CONFIG` are
now exported; `RoomWatcher`'s private `runPrompted` returns whether it ran rather
than swallowing a ceiling refusal.

**Breaking (type-level):** `WakeReason` gains `"scheduled"`. Anything switching
exhaustively over it needs the new case.
