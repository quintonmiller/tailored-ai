---
"@tailored-ai/core": patch
---

Notification seams: core stops deciding who to notify and how. The autopilot
worker, the `ask_user` tool, and the `channel_message` workflow executor no
longer DM the owner inline — they emit typed runtime events that the new
default `builtin:owner-notifier` plugin subscribes to and delivers. The
autopilot task prompt becomes a config-overridable template.

- New typed events on the runtime bus: `task.needs_human` (task errored/blocked),
  `digest.ready` (morning digest), `question.asked` (`ask_user`), and
  `form.completed` (channel_message owner-DM fallback).
- New default plugin `builtin:owner-notifier` (seeded enabled in
  `DEFAULT_PLUGIN_MODULES`) resolves the owner via `runtime.resolveOutbound()` +
  `runtime.getOwnerId()` and DMs them — same channel/recipient resolution and the
  same autopilot quiet-hours suppression that lived inline. Disable it and
  subscribe your own handler to ship notifications anywhere (Slack, Telegram,
  email, pager).
- New `config.autopilot.taskPrompt` template (vars: `{{task_id}}`,
  `{{task_title}}`, `{{task_description}}`, `{{prior_activity}}`), expanded by
  `buildTaskPrompt()`; `DEFAULT_CONFIG` ships the existing rules verbatim.
  `buildTaskPrompt` / `DEFAULT_AUTOPILOT_TASK_PROMPT` moved to
  `autopilot/task-prompt.ts` (re-exported from `autopilot/worker.ts`).
- New `config.tools.ask_user.inboxFile` (default `"inbox.md"`) makes the
  out-of-autopilot inbox filename configurable.

Behavior is identical with the default config + default plugins: every
notification fires exactly as before, including quiet-hours suppression and the
byte-identical task prompt. The `channel_message` executor only routes the
implicit "DM the owner" fallback through the event bus; explicit `channelId` /
`userId` / per-step `channel` targets stay direct deliveries.
