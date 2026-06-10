---
"@tailored-ai/core": patch
"@tailored-ai/cli": patch
---

Make generic core delivery channel-neutral and remove Discord coupling from
code that isn't the Discord channel itself. These are breaking pre-1.0 renames
with no aliases (single user, pre-V1).

Renames (old → new):

- Workflow step type `discord_message` → `channel_message`; executor
  `DiscordMessageExecutor` → `ChannelMessageExecutor`. The step gains an
  optional `channel` (outbound channel id; absent = default channel). The
  `DiscordSender` alias is gone — executors take `OutboundNotifier` directly.
- Tool `discord_dm` (`DiscordDmTool`) → `notify_owner` (`NotifyOwnerTool`),
  resolved via `resolveOutbound(channel?)` / `getOwnerId(channel?)` with an
  optional `channel` param and channel-neutral error text.
- Default plugin `builtin:discord-notifier` (`DiscordNotifier`) →
  `builtin:agent-notifier` (`AgentNotifier`). Delivery was already
  channel-neutral via `taskWatcher.delivery.{channel,mode,target}`; only the
  name/log-prefix changed.
- Config tool key `tools.discord_dm` → `tools.notify_owner` (now
  `{ enabled; channel? }`).
- Barrel: `buildDiscordNotification` is exported as `buildNotification`;
  `DiscordSender` / `DiscordMessageExecutorOptions`-as-was are dropped in favor
  of `ChannelMessageExecutorOptions`.

The `notify` and form-`notify` channel fields are now open strings: `email`
and `log` keep their special cases, every other value is an outbound channel id
resolved from the runtime's outbound registry.

Two cheap config migrations (only back-compat kept):

- `migrateDefaultPlugins` rewrites an existing `builtin:discord-notifier`
  entry (string or object form, preserving `enabled` / `config`) to
  `builtin:agent-notifier`.
- `loadConfig` moves a legacy `tools.discord_dm` block to `tools.notify_owner`.

Bug fix: the runtime config-reload path rebuilt tools WITHOUT the outbound
accessors, so reloaded `notify_owner` / `ask_user` tools silently lost channel
access. Reload now passes the same `resolveOutbound` / `getOwnerId` accessors as
the constructor.

The legitimately-Discord channel implementation
(`channels/discord*.ts`, `DiscordChannel`, `getDiscordConfig`, the
`builtin:discord` channel factory) keeps its names. Behavior for a
Discord-configured install is unchanged — channel id `"discord"` still works.
