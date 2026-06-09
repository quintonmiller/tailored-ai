---
"@tailored-ai/core": patch
"@tailored-ai/cli": patch
---

Extract Discord delivery out of TaskWatcher into a `DiscordNotifier`
default plugin — Slice 3 step 1 of the platform vision
(`docs/platform-vision.md`). The watcher emits `agent.completed`
when a loop returns; `DiscordNotifier` subscribes and decides whether
to deliver based on the final task state.

- New `agent.completed` event in `RuntimeEventMap`. Payload carries
  `taskId`, `projectId`, `agentName`, the initial + final task
  snapshots (id/title/description/status/assignee), and the agent's
  response.
- New `packages/core/src/plugins/discord-notifier.ts`. `DiscordNotifier`
  class constructed with `{ runtime, notifier? }`, subscribes on
  construction, disposes on `stop()`. Owns `shouldSuppressDelivery`,
  `buildNotification`, `nextActionHint`, `findBranchInTaskComments`,
  `isKnownAgent`, the `deliver` channel-routing logic, and the
  `emojiForStatus` helper. Notifier is mutable via `setNotifier()` so
  the CLI can swap it on Discord connect / disconnect / reload.
- `TaskWatcher` loses `notifier`, `setNotifier`, `setDiscord`, `deliver`,
  `buildNotification`, `nextActionHint`, `findBranchInTaskComments`,
  `shouldSuppressDelivery`, and `isKnownAgent`. After agent loop +
  stall handling + scope check, it emits `agent.completed` instead
  of inlining delivery. The watcher's responsibility narrows to
  routing + dispatch.
- CLI constructs `new DiscordNotifier({ runtime, notifier })` alongside
  `new TaskWatcher({ runtime })`, and the hot-reload notifier-swap
  now calls `discordNotifier.setNotifier` instead of the watcher.

No behavior change for users. The delivery rules + envelope formatter
are byte-identical to before — the tests that pinned the format moved
to `discord-notifier.test.ts` and still pass.

Slice 3 step 2 (stall-guard + scope-creep flagger plugins) and step 3
(project_id guardrail plugin) follow as separate PRs, building on
this event surface.
