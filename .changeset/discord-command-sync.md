---
"@tailored-ai/core": patch
---

Fix Discord slash-command registration: guild-scoped, and no longer duplicated.

Commands were published globally, which Discord can take up to an hour to show
to clients — indistinguishable from "the commands don't work". When
`channels.discord.guildId` is set (or the bot is in exactly one guild) they are
now written to that guild instead, where they appear immediately. Global
registration remains the fallback and logs the propagation delay.

Also removes the clear-then-write pattern in `syncCommands`. A bulk overwrite
already replaces the whole set, so clearing first only widened the window for a
concurrent sync — `ClientReady` and `onReload` landing together left every
command registered twice. Syncs are now serialized, and the guild path clears
the global copies so the two sets cannot appear side by side.
