---
"@tailored-ai/core": patch
---

Agent-to-agent direct messages can now be observed.

`deliverAgentMessage` emits a new `agent.messaged` runtime event once per
exchange, after the recipient's loop returns, so one event carries the message
and its reply together. `via` distinguishes `dm` (an agent chose to speak) from
`delegate` (task handoff), because a subscriber that cannot tell them apart
either drowns in delegation traffic or misses it. A delivery that throws emits
nothing.

Adds `builtin:dm-mirror`, disabled by default, which turns that event into a
line in a room. It posts with no `to` so nobody is addressed, and it refuses to
run at all when the target room has any subscriber whose `wakeOn` is not
`"none"` — re-checked on every reload, since an agent can subscribe itself at
runtime and turn a safe room into a feedback loop with no config edit.

Previously a direct message left only a session row, so a pair of agents could
talk all night with no event to subscribe to and no way to mirror, audit or
count one without patching core.
