---
"@tailored-ai/core": minor
"@tailored-ai/cli": patch
---

Stop privileging the built-in Discord channel in config. `config.channels`
is now a uniform id-keyed map of `{ enabled?, ...opaque options }` — the
special-cased typed `channels.discord` block is gone. The Discord channel,
like any plugin channel, owns its own schema: a new dependency-light
`channels/discord-config.ts` exports `DiscordConfig` + `getDiscordConfig()`,
which parses the opaque slice once. All readers (the Discord channel itself,
the cron scheduler, the discord-notifier plugin, the task-watcher, and the
CLI) go through it, so core carries no per-channel types.

Non-breaking: existing `channels.discord: { token, owner, … }` configs stay
valid (they're already option bags) — no migration, no fixture changes. The
`enabled` flag stays first-class on every channel via the map's value type.
