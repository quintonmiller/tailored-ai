---
"@tailored-ai/core": patch
---

delegate: know that a sub-agent failed, and hear when it finished

Both from one incident. An executive assistant delegated a lookup, was asked for
an update 52 minutes later, and had the answer available the whole time.

**A stalled sub-agent was reported as a success.** `delegate` returned
`{success: true, output: response}` no matter how the loop ended, so a sub-agent
that ran out of tool rounds came back as a successful call whose output happened
to be `[Agent stopped: max tool rounds reached]`. The caller could not tell
"answered" from "gave up" and silently retried. It now branches on `onStop` —
which exists for exactly this, and whose docblock says *"Branch on this, not on
the returned string"* — and returns `success: false` with the reason, the partial
output, and what to do about it.

**Async delegation had no completion path at all.** `startTask` was a `Map` and a
`.then()` that mutated a record: no callback, no event, no notifier. The only way
to learn an outcome was to ask. So the agent promised a person a follow-up it had
no mechanism to make, and the result sat unread — **9 minutes from being evicted
by the registry's one-hour TTL**, which is lazy and sweeps when the next task
starts rather than on a timer.

`delegate(async: true, notify: true)` now delivers the outcome — success or
failure — into the delegating agent's own session, through the same
`deliverAgentMessage` path `room(action="dm")` uses, attributed to the agent that
did the work. `notify: false` remains the default: a clean hand-off, now an
explicit choice rather than an accident.

**The tool result says what will actually happen.** It used to read `Background
task started: <id>`, which reads like a promise. Without `notify` it now states
that nobody will tell you, names the `task_status` call that collects it, warns
against promising a follow-up you have not collected, and mentions the one-hour
expiry. `notify` requested where there is nobody to notify — an un-named CLI or
API session, or delegating to yourself — says so instead of accepting the flag
and dropping it.

`startTask` gains an optional `onFinish` callback. A notifier that throws or
rejects is contained and logged: the task's result is the only thing recoverable
afterwards and must not be lost with it.
