---
"@tailored-ai/core": patch
---

Resolve the `DiscordNotifier` default plugin's Discord sink from the runtime's
outbound registry instead of a constructor-injected notifier (#66, #142).

`DiscordNotifier` now takes only `{ runtime }` — the `notifier` option, the
private notifier field, and `setNotifier()` are gone. At delivery time it reads
`runtime.getOutbound("discord")` (keeping the existing "Discord is not
connected" guard) and resolves the `discord-dm` owner fallback via
`runtime.getOwnerId("discord")`. The CLI drops the now-dead injected-notifier
machinery (`_discordNotifier` global, the `notifier` local, the
`setNotifier()` hot-swap on reload). This was the last consumer on the legacy
injected path — cron, autopilot, the workflow engine, the createTools tools,
and now this plugin all resolve the Discord sink through the registry. Behavior
is unchanged for a Discord deployment with an owner configured. Opening the
`delivery.channel` union beyond `"discord"` is the remaining #142 work and is
separate.
