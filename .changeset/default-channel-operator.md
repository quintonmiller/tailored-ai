---
"@tailored-ai/core": patch
---

Add a channel-neutral operator identity so the task-watcher no longer hardcodes
Discord (#155).

New `config.defaultChannel` names the deployment's primary channel (a key in the
existing opaque `channels` map). `runtime.getPrimaryOwner()` resolves the
operator — `{ channelId, userId, displayName }` — from that channel's `owner`,
falling back to the first channel that declares an owner, then the first
registered channel. The task-watcher's no-agent "primary session" routing and
its prompt owner-name now go through this instead of `getDiscordConfig().owner`
+ a hardcoded `"discord"` channel id.

Back-compatible: a Discord deployment with `channels.discord.owner` set and no
`defaultChannel` still resolves to `{ channelId: "discord", userId: <owner> }`,
preserving the existing `discord:<owner>` session key. Prerequisite for the
channel-neutral outbound router (#66) and per-plugin channel routing (#142).
