---
"@tailored-ai/server": patch
---

Make the UI + server delivery editors and config sections channel-neutral, the
matching half of the core channel-neutral refactor (pairs with #192).

UI: the workflow step `discord_message` becomes `channel_message` with an
optional outbound `channel` id (blank = default channel); the `notify` and form
`notify` channel pickers open to an arbitrary channel id alongside the
`email`/`log` specials; the Cron and Task-watcher delivery editors swap the
hardcoded `log`/`discord`/`discord-dm` preset list for a `log`/`channel`/`dm`
mode select plus an open "Delivery Channel" id field and the existing target
field, mapping to/from the `{ channel, mode, target }` shape. Labels and
placeholders are neutralized (no more "Discord channel/user ID"), and the
workflow templates / metadata / graph drop their hardcoded Discord references.

Server: the config-section route resolves `channels.<id>` keys generically
(e.g. `channels.discord` → `channels.discord` in YAML) instead of a hardcoded
`discord` entry in `SECTION_MAP`, so each channel's setup page reads/writes its
own section without a built-in list. The Discord setup page now targets
`channels.discord`. The Discord setup/config page stays as the Discord
channel's own config surface.
