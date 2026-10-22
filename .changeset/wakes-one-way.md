---
"@tailored-ai/core": patch
---

Tends, upkeep and booked wakes go through the one way to wake an agent.

Three kinds of turn nobody asked for still started their own loop, so they
skipped the agent's hourly wake ceiling and their tools couldn't tell why they
ran: the places plugin's `tend`, the directory's upkeep (scheduled, and **Tidy
up now**), and the wakes an agent books for itself in a session with
`schedule`. All three now go through `runtime.wakeAgent`, with `wake.kind`
`tend`, `upkeep` and `schedule`, and keep everything else they did: their
timing, sessions and messages, upkeep's round budget and its "Last upkeep"
line, and a schedule's storage and claim-then-dispatch.

What a deployment will notice:

- Each tend, upkeep turn and session schedule wake counts as one of the
  agent's `rooms.maxWakesPerHour` wakes, shared with its subscription wakes.
  At that ceiling a tend or a scheduled upkeep is skipped until the agent's
  next time, before anything is read, and the log says why. A one-shot booked
  in a session waits until the hour has room, however long that takes within
  the hour, and keeps its due time so the agent hears how late it is; it is
  never given up for the ceiling. A recurring occurrence is deferred five
  minutes at a time, up to `schedules.maxDeferrals`, as a room wake already
  was, and then left for the next one.
- **Tidy up now** answers `409` when the agent is at its hourly ceiling ("…
  can't tidy up now: it's at its wake ceiling: 12 wakes in the last hour. Try
  again later."), and the page shows it, even while another agent's tend or
  upkeep is running. If the agent reaches the ceiling while the turn reads its
  evidence, the page says why it couldn't tidy up, in the waker's words.
- A wake an agent booked in a session now waits while that online agent is
  switched off or paused on the Agents page, as it does for a global pause: a
  one-shot runs when the switch is undone, and says how late it is; a
  recurring occurrence is skipped. Before, it ran regardless.
- `notify_owner` in a tend or an upkeep turn goes through the repeat gate, as
  in any turn nobody asked for: within `notifications.dedup.windowHours`
  (default 24) a message that matches one already sent, exactly or closely
  enough by wording (`similarityThreshold`), is held back and the agent is told
  so. A wake an agent booked is not gated, in a session or a room: a reminder
  says the same thing each time it comes round, and each time is wanted.
- A session schedule wake whose agent no longer exists is retired, instead of
  failing each time it comes round.
- Their log lines start `[wake]`.

For plugins, `runtime.wakeAgent` takes `sessionId` (a session that already
exists, by its id; `gone` when there's no such session) as well as
`sessionKey`, and `maxToolRounds`, a cap on a session turn's rounds of tool
calls that an agent configured for fewer doesn't exceed. More than one of
`sessionKey`, `sessionId` and `room`, or `maxToolRounds` with a room, throws
rather than being dropped. One woken turn at a time now holds per session
however it's named. The new
`runtime.wakeRefusal(agent, { sessionKey } | { sessionId })` says whether a
session wake would be turned away now, and why in words, without running or
counting anything, for a caller that answers before its turn starts; at the
hourly ceiling it also says `until`, when the hour next has room.
