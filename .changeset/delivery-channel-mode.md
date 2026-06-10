---
"@tailored-ai/core": patch
---

Open the `delivery.channel` union to a `{ channel?, mode?, target? }` shape so
task-watcher and cron delivery can target any channel id, not just Discord
(#142, Option A).

`TaskWatcherConfig.delivery` and `CronJobConfig.delivery` previously pinned
`channel` to a closed `"log" | "discord" | "discord-dm"` set that conflated
*which* channel with *channel-post vs DM*. Now `channel` is an open id (resolved
against the runtime's outbound registry via `getOutbound`) or the reserved
sentinel `"log"` (console only, the default when omitted), `mode` is
`"channel"` (post via `send`, default) or `"dm"` (direct message via `sendDM`),
and `target` is the room id (channel mode) or user id (dm mode, defaulting to
`getOwnerId(channel)`).

A new idempotent `migrateDeliveryConfig` (run in `loadConfig` and
`mergeProjectOverlay` alongside `migrateTaskBackendConfig`) maps the legacy
string values onto the new shape, preserving `target`: `"discord"` →
`{ channel: "discord", mode: "channel" }`, `"discord-dm"` →
`{ channel: "discord", mode: "dm" }`, `"log"` → `{ channel: "log" }`. Existing
configs keep working with no edits. The `DiscordNotifier` plugin and
`CronScheduler.deliver` share the same resolution logic; cron's old
`getDiscordConfig(...)?.owner` DM fallback is replaced with
`runtime.getOwnerId(channelId)`. The other half of #142 — registering the
default plugins through the config-toggleable loader — is separate/upcoming.
