# Schedules: agents that wake themselves

An agent can book its own future wake with the `schedule` tool. This is the only
path where the agent, rather than the operator or the traffic, decides when it
next runs.

## Why this exists

Everything else that starts a turn is authored by somebody else:

| Path | Authored by | Can express |
|---|---|---|
| `cron.jobs` | operator, in `config.yaml` | recurrence only, cron/DSL syntax |
| `checkInMinutes` | operator, per room subscription | one fixed interval, forever |
| poll / message wakes | traffic | nothing about the future |

So an agent that said "I'll check back after the deploy" was describing
something no part of the system would do. `schedule` is what makes that sentence
true.

## The tool

```
schedule(action="once",   when="10 minutes", note="check if the deploy PR merged")
schedule(action="repeat", every="weekdays at 9am", note="morning sweep",
                          starts="2026-08-11", until="2026-09-30")
schedule(action="list")
schedule(action="cancel", id="a3f1")        # one
schedule(action="cancel", id="a3f1,b7c2")   # some
schedule(action="cancel", all=true)         # all
```

`note` is required. It is everything the agent will have to go on when it wakes,
and a wake that arrives with nothing to act on cannot recover.

Every accepted booking echoes back the absolute time it resolved to:

> `Scheduled a3f1 for Thu, Aug 07, 10:00 (in 2h 14m), waking in #executive.`

That echo is the safety property, and it matters more than parser cleverness: a
model that meant tomorrow and got today finds out in the same turn, while it can
still fix it. A rejected call answers with the grammar it wanted, because error
text is the only documentation a model reliably reads.

### `when` — one-shots

Civil-time forms use the runtime's effective IANA timezone. By default that is
the host timezone; set `time.timezone` when a container, VM, or WSL environment
does not match the person using TAI. Relative durations are elapsed time and do
not depend on a timezone.

| Form | Example |
|---|---|
| relative | `10 minutes`, `10m`, `2h`, `in 45 minutes`, `3 days`, `1 hour 30 minutes` |
| absolute | `2026-08-08 10:00`, `2026-08-08T10:00:00`, `2026-08-08 9am` |
| date only | `2026-08-08` → 09:00, and the echo says so |
| clock only | `9am`, `21:30`, `noon` → the next time it is that o'clock |
| day word | `tomorrow`, `tomorrow 9am`, `today 5pm` |

A bare number (`10`) is refused rather than guessed: it reads equally as ten
minutes and ten o'clock, and a wake nine hours off is worse than one the model
has to phrase again.

### `every` — recurrence

Two modes, and the difference is load-bearing:

- **interval** — `every 30 minutes`, `every 2 hours`, `every 3 days`, `hourly`.
  Stored as elapsed seconds, phase-anchored to `starts`. "Every 2 hours from
  10:15" means 12:15, 14:15.
- **cron** — everything else goes to [`compileSchedule`](../packages/core/src/cron/schedule-dsl.ts):
  `weekdays at 9am`, `every monday at 8:30`, raw cron. Wall-clock aligned.

Intervals do not go through cron because cron cannot express phase.
`compileSchedule("every 2 hours")` compiles to a step-hour expression that fires
on even hours and silently discards the start minute — not what an agent asking
at 10:15 meant. Cron also has no way to say "every 3 days" at all.

`starts` gates when the pattern becomes active; `until` retires it.

## Where a wake lands

Decided when the wake is booked, from the room the turn was woken for
(`WAKE_ROOMS_KEY` in working memory, already how `room(action="pass")` scopes
itself):

- **one woken room** → that room
- **several** (a batched wake) → refused, naming them, asking for `room="…"`
- **none** → the session the booking was made in

A room wake goes through `RoomWatcher.runScheduledWake`, which shares
`runCheckIn`'s tail. So it inherits the per-room turn chain, the in-flight
guard, `maxWakesPerHour`, `pass` handling, the silence refund and repeat
suppression. A self-booked wake is not a way around the deployment's brakes.

A session wake runs the loop against that session and persists the reply there.
Nothing is pushed anywhere, and both the booking echo and the wake prompt say
so — an agent that assumes it has been heard will not use the tools that would
actually reach someone.

## Firing

One poll tick over an indexed `next_run_at`, not a timer per schedule
([`schedules/runner.ts`](../packages/core/src/schedules/runner.ts)).

`setInterval` armed at startup drifts, and survives neither a restart nor a
suspend nor a clock jump. A due time in the database survives all three: a wake
missed while the service was down is still due when it comes back and fires on
the next tick instead of evaporating.

**Claim, then dispatch.** An agent turn takes minutes; the tick runs every
thirty seconds. The row is advanced out of the due set *before* the loop starts,
so a slow turn cannot be re-fired underneath itself. Delivery is therefore
at-most-once, which is the right side to fail on — a wake that arrives twice is
worse than one that arrives never, and the crash window between claim and
dispatch costs exactly one wake, logged.

**A recurrence advances strictly past now.** Three hours of downtime produces
one wake, not three.

**Lateness is reported.** A wake more than two ticks late tells the agent so,
with no guess at the cause.

### Pauses

`isAgentsPaused("autonomous")` stops scheduled wakes, as it stops cron and
check-ins. A recurring occurrence is skipped — the next comes round anyway — but
a one-shot is left due, so a commitment made before the pause is kept the moment
it lifts. A commitment survives a pause; a heartbeat does not need to.

### Refusals

| Outcome | Meaning | What the scheduler does |
|---|---|---|
| `ran` | the turn happened | records the run |
| `at-ceiling` | temporarily refused (wake ceiling, paused, turn in flight) | retries in 5 minutes, up to `maxDeferrals` |
| `gone` | the agent left the room, or it was archived | retires the schedule |

A refused wake is not counted as a run: counting it would misreport the run
number to the agent and reset the deferral streak that stops a room permanently
at its ceiling retrying for ever.

## Configuration

```yaml
time:
  provider: system
  timezone: America/Los_Angeles  # optional; host timezone when omitted

schedules:
  enabled: true            # kill-switch; also removes the tool
  tickSeconds: 30          # how often the due set is checked
  maxPerAgent: 20          # live schedules one agent may hold
  minIntervalMinutes: 15   # floor on how often a recurrence may fire
  maxHorizonDays: 365      # furthest a one-shot may be booked
  maxDeferrals: 3          # retries when a room is at its ceiling
```

Timezone precedence is explicit config, then a plugin provider's timezone,
then the host timezone. TAI logs the effective provider, timezone, and source at
startup and on reload. Invalid timezone names fail clearly instead of silently
falling back to UTC. Absolute instants continue to be stored and compared in
UTC; only calendar interpretation and rendering use the configured zone.

`time.provider` defaults to `system`. A plugin can register another provider
through `ctx.timeProviders.register(id, factory)` and supply `now()`, an
optional `timeZone()`, or both. Provider-specific settings belong under the
opaque `time.options` bag. Changing `time.provider` or `time.timezone` is
hot-reloadable.

An agent only gets the tool if its `tools:` list includes `schedule` — or if it
has no list at all, in which case it gets every tool and this one arrives with
the next restart.

### Forgotten recurrences

The brake is not an expiry timer the agent never sees. Every recurring wake
names itself and its age in its own prompt:

> This is recurring wake `a3f1` ("weekdays at 9am", run 18).
> If it is no longer useful, cancel it: `schedule(action="cancel", id="a3f1")`.

Informing beats overriding, and it makes the agent the collector of its own
garbage.

## Storage and events

One table, `agent_schedules`. `next_run_at` is the only column the tick reads.
`listDue` takes the time from its caller rather than using `datetime('now')`, so
the runner's injected clock is the only clock and every timing rule is testable
without waiting.

Three events for plugin subscribers: `schedule.created` (on booking, so a
subscriber sees intent before it happens), `schedule.fired` (only when a turn
actually ran), `schedule.cancelled`.

## Known limits

- **DST.** Cron and civil-time one-shots honor the configured zone across DST.
  A nonexistent spring-forward wall time is rejected rather than silently
  shifted. Interval mode is elapsed time, so its wall-clock display moves by an
  hour across a transition by design.
- **No operator surface yet.** `list` and `cancel` are agent-facing only; there
  is no HTTP route, CLI command or dashboard widget. Inspect the table directly
  until there is.
