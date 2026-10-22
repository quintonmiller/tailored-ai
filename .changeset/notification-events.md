---
"@tailored-ai/core": patch
---

The notification gate says what it sends, and lets a plugin hold one back.

Every message an agent sends without being asked (a cron delivery, a blocked
task, a digest, a question, `notify_owner` from a tick or a woken turn, a room
post) already passed the repeat gate. It now announces each one on the
runtime's bus:

- `notification.outgoing`, a waterfall, runs before the repeat check with
  `{ source, kind, agent?, channel, target, preview }`. A subscriber that sets
  `deny` holds the message back. Nothing is sent, and the gate logs it like a
  repeat with that reason. An agent whose `notify_owner` call or room post was
  held back gets the reason as the tool's answer.
- `notification.sent`, a broadcast, follows a message that went out, with the
  same fields plus `logId` (its `notification_log` row) and `at`. It never fires
  for a repeat, a held-back message, or a send that threw.

Both are in the event catalog, so `hooks.on` can bind to either and a
subscription can wake an agent on `notification.sent`. Both name the agent, so
a hook declared under an agent sees only that agent's messages. A hook that
refuses on `notification.outgoing` holds the message back. A `script` hook
there refuses whenever it exits non-zero or times out, whatever `onError` says,
so put a hook that only watches on `notification.sent`.

A room post that was held back also keeps that turn's closing reply out of the
room, so the agent's next sentence can't undo the hold. A message a
`notification.outgoing` subscriber sends while it runs isn't run through the
waterfall again, so a hook that copies messages somewhere can't loop. That
skip ends when the subscriber returns: a timer it set, or an agent its copy
woke, goes through the waterfall like any other message.

The gate waits for `notification.outgoing` five minutes at most, then logs a
timeout and sends the message anyway, so a subscriber that never returns can't
stop every unprompted message, or a room's turns, until a restart.

`NotificationCandidate` gains `kind` and `agent`. A kind is coarse, one per
sort of message: `cron:<job>`, `task-blocked`, `digest`, `question`,
`notify:<what woke it>` or `notify`, `room`. Without one, it is the `source`
with the agent's name taken off the end. The new `held` verdict and the
decision's `reason` say a subscriber stopped the message. `resolveGate`,
`PASSTHROUGH_GATE`, `NotificationGateLike` and `notificationKind` are now
exported from `@tailored-ai/core`, as the notifications doc already said.

Nothing changes for a deployment that subscribes to neither event. A gate built
without a bus works as before.
