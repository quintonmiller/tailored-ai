---
"@tailored-ai/core": patch
---

Discord: one duplicate command name no longer freezes every slash command in the guild

Discord rejects the *whole* bulk overwrite when a payload names one command
twice, and the overwrite is all-or-nothing — so a rejected payload changed
nothing and the guild kept whatever set last registered successfully. Every
command was frozen, built-ins included, `/pause` included. On a first run the
guild got no commands at all. The only symptom was one line of `console.error`;
the bot was otherwise healthy and the stale commands still worked.

Nothing checked config command names against each other or against the
built-ins, and normalization erases the difference between `Deploy`, `deploy`
and `deploy!`.

`dedupeCommandNames` now drops the later of any colliding pair and warns naming
both sides, so one bad config entry costs one command instead of all of them.
Push order is precedence order — built-in, then plugin, then config — so a
config entry can never take `/pause`'s slot. (Plugin commands moved below the
built-ins as part of this. `SlashCommandRegistry` already refuses
`RESERVED_COMMAND_NAMES`, so this is drift-safety rather than a live hole: if
that hand-kept list ever falls behind the set actually built, the dedupe now
fails toward the built-in.)

`registeredCommandsHash` is also recorded on a 4xx. It was assigned only after
the request resolved, so a payload Discord deterministically rejects was re-sent
identically on every `ClientReady` and every config reload, forever. A 5xx or a
dropped connection still retries. The log line now says the guild's commands are
unchanged and may be stale, rather than only quoting the error.
