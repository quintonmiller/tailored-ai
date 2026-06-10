---
"@tailored-ai/core": patch
---

Default the workflow engine's Discord delivery to the outbound registry (#66,
follow-up). `createWorkflowEngine` now resolves `getDiscord` /`getOwnerId` from
`runtime.getOutbound("discord")` / `runtime.getOwnerId("discord")` when the host
doesn't pass them, so the notify, discord-message, and form executors no longer
need the live Discord channel hand-injected. The CLI drops the `getDiscord` /
`getOwnerId` it was passing to `createWorkflowEngine`. Behavior is unchanged —
`getOutbound("discord")` returns the same channel instance the CLI registers,
and `getOwnerId("discord")` reads `channels.discord.owner`. Callers may still
override both (e.g. tests).
