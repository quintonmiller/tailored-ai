---
"@tailored-ai/core": patch
"@tailored-ai/cli": patch
---

One way to wake an agent, under the same brakes.

Only subscription turns used to stop for the pause switch and the hourly wake
ceiling, because those lived inside subscription delivery. A plugin that
started a turn of its own called `runAgentLoop` and skipped both.

`runtime.wakeAgent(agent, { prompt, sessionKey | room, wake })` is now how a
plugin starts a turn nobody asked for. It returns `ran`, `paused`, `at-ceiling`
or `gone`: it runs nothing while autonomous turns are paused, holds the agent
at `rooms.maxWakesPerHour` session wakes an hour (one count shared with
subscription wakes, not two), turns away a second wake into a session whose
woken turn is still running, and is `gone` for an agent that isn't there or an
online agent switched off on the Agents page. A `room` turn goes through the
room's own turn order and ceiling; the CLI connects the room watcher with the
new `runtime.setRoomWaker`. Each woken turn emits the new `agent.woken` event.

A turn now knows why it is running. `wake: { kind, ref }` reaches its tools as
`ToolContext.wake`, on every `wakeAgent` turn and every subscription turn. The
`agent.pre_tool_use` payload gains `effect` (what the tool declares the call
does, `read` when it declares nothing), `effectDeclared` and `wake`, so a
policy can act on irreversible calls, or on calls in unprompted turns, without
knowing the tool. How the loop's own checks read an undeclared tool is
unchanged.

What a deployment will notice:

- `notify_owner` in a woken turn (a subscription's, or a plugin's) now goes
  through the repeat gate, as it already did for background ticks and
  autopilot runs. A person's own chat is not gated.
- Subscription events for an agent that doesn't exist are dropped with a
  warning instead of failing and retrying for an hour. Events bound for the
  session of an online agent switched off on the Agents page are dropped too.
- Log lines for a session subscription wake now start `[wake]`.

The places plugin's `tend` turn still starts its own loop; it moves onto
`wakeAgent` in a follow-up.
