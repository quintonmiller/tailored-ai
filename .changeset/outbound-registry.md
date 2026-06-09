---
"@tailored-ai/core": patch
---

Add a channel-id-keyed outbound-notifier registry on the runtime (#66, first
step). `registerOutbound` / `unregisterOutbound` / `getOutbound` / `listOutbound`
let consumers resolve a live delivery sink by channel id instead of being
hand-injected the single Discord notifier, and `resolveOutbound(channelId?)`
applies the channel-neutral fallback (explicit id → `config.defaultChannel` via
`getPrimaryOwner`).

The Discord channel registers itself into the registry on connect and on
config reload (CLI). `CronScheduler` now resolves its sink through
`runtime.getOutbound("discord")` instead of a constructor-injected notifier —
its `notifier` / `discord` options and `setNotifier` / `setDiscord` are removed.
Behavior is unchanged (cron still delivers to Discord). Autopilot, the
DiscordNotifier default plugin, and the workflow notify executor still use the
existing path; migrating them — and opening the `delivery.channel` union — is
the follow-up (#142).
