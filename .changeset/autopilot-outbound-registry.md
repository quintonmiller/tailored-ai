---
"@tailored-ai/core": patch
---

Route the autopilot worker's digest + notification delivery through the
outbound registry instead of injected Discord accessors (#66, follow-up).

`AutopilotWorker` no longer takes `getNotifier` / `getDiscord` / `getOwnerId`;
it resolves the sink via `runtime.resolveOutbound()` and the recipient via the
new `runtime.getOwnerId(channelId?)` — the real configured `channels[id].owner`
(or undefined, so delivery is skipped when no operator is set, unlike
`getPrimaryOwner().userId` which substitutes a synthetic `"owner"` for session
keys). The CLI drops the Discord-specific autopilot wiring. Behavior is
unchanged for a Discord deployment with an owner configured.

Still on the legacy injected path (next steps): the workflow notify executor +
Discord-message executor + the `dm` tool, all fed by the shared `getDiscord` /
`getOwnerId` closures in `factories.ts` / `workflows/factory.ts`; and the
`DiscordNotifier` default plugin (#142).
