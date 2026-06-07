---
"@tailored-ai/core": patch
---

Wire task lifecycle emissions onto the runtime event bus — Slice 2 of
the platform vision (`docs/platform-vision.md`). The `tasks` tool now
emits typed `task.created` / `task.updated` / `task.transitioned` /
`task.commented` events alongside the legacy `notify` watcher
callback. Plugins can subscribe via `ctx.events.on(...)` without
reaching into the watcher class.

- `TasksTool` accepts an optional `{ events }` options bag. On a
  successful `create`, it emits `task.created`. On `update`, it diffs
  the before/after task and emits `task.updated` with the changed
  field list. If status changed, it fans out a separate
  `task.transitioned` with `from`/`to`/`assignee`. If the update path
  posted a status-change comment, it also emits `task.commented`.
  On `comment`, it emits `task.commented`.
- `AgentRuntime` threads `runtime.events` through to `createTools`,
  so any tool factory wired to a runtime gets the bus automatically —
  the CLI doesn't need to wire it explicitly.
- `createTools` accepts `events?: EventBus` in its options and forwards
  it to `TasksTool`.

The legacy `notifyTaskEvent` callback keeps firing, so the existing
watcher behavior is unchanged. Slice 3 will start migrating the
watcher's individual responsibilities to plugins that consume these
events; the watcher's notify hook eventually disappears.

11 new tests cover each emission path plus the no-bus back-compat case.
