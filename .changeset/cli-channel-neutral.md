---
"@tailored-ai/cli": patch
"@tailored-ai/core": patch
---

Finish the channel-neutral sweep in the CLI: the setup wizard/TUI editor and
the server runner stop special-casing Discord. The Discord channel
implementation and the `channels.discord` config block stay legitimately
Discord; only the channel-generic bookkeeping changed (single user, pre-1.0, no
back-compat).

CLI:

- Outbound registration in `index.ts` is now channel-generic. Instead of
  tracking a single live `DiscordChannel` and registering/unregistering the
  `"discord"` id by hand, the runner walks every connected channel from the
  lifecycle manager and registers any that satisfies `OutboundNotifier`
  (`id` + `send` + `sendDM`) into the runtime's outbound registry. A
  `syncOutboundRegistry` helper reconciles registered ids against the live set
  on connect and on every reload, so Slack/Telegram/etc. drop in by id with no
  per-channel code.
- TUI editor models channels as a generic `Record<string, boolean>` map. The
  reducer action `toggleDiscord` is now `toggleChannel { channelId }`; the
  ChannelsEditor renders one toggle row per channel id (sorted, stable), and
  the menu/detail panes iterate the map. `discord` is always seeded into the
  draft (default false) so the built-in shows even when absent from config.
- The setup wizard still emits the built-in `channels.discord` block, but
  `hydrateFromYaml` / `patchExistingYaml` read and write through the generic
  `channels.<id>.enabled` map rather than a dedicated discord boolean, so the
  editor can toggle arbitrary channel ids.

Core: neutralize the one autopilot log string ("no Discord target" → "no
delivery target") so it matches the channel-neutral delivery path.
