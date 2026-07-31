---
"@tailored-ai/core": patch
"@tailored-ai/server": patch
"@tailored-ai/cli": patch
"@tailored-ai/channel-slack": patch
---

Add a global pause switch: `/pause` and `/resume` in Discord.

Two agents on a metered API answered each other unattended and spent real money
in twenty minutes, and there was no way to stop it from a phone. Killing the
process loses in-flight work, editing config calls `runtime.reload()` and
bounces the very Discord gateway you are typing into, and `autopilot pause`
covers one of six things that can start a run.

**`/pause` blocks autonomous runs only.** Cron timers, webhooks, all eight
workflow trigger pollers, autopilot, exploratory ticks, task auto-dispatch and
stall retries, room check-ins, agent-to-agent wakes and DMs. Your own messages
keep working on purpose: a pause that also kills your DMs is indistinguishable
from an outage, and it removes the instruments you would use to inspect what
went wrong. `/pause scope:all` adds human-initiated runs.

**In-flight runs finish.** The gate refuses new runs; aborting a half-finished
tool call turns an expensive mistake into an expensive mistake plus an
inconsistent worktree. Child workflows started by a running parent are treated
as continuations for the same reason.

State lives in a new `runtime_settings` singleton table, read live on every
check — the same shape as `autopilot_settings`, and in SQLite rather than
config for the reload reason above. `AgentRuntime` gains
`isAgentsPaused(kind)`, `getPauseState()` and `setAgentsPaused()`, and a real
change emits `agents.pause_changed` on the runtime bus.

Server, CLI and Slack are touched only to refuse politely under `scope: all`,
plus one gate in core's own webhook `action: agent` route, which reaches the
agent loop without passing through the workflow engine.
