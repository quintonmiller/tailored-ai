---
"@tailored-ai/core": patch
"@tailored-ai/cli": patch
---

Extract stall detection + retry out of TaskWatcher into a `StallGuard`
default plugin — Slice 3 step 3 of the platform vision
(`docs/platform-vision.md`). The watcher emits `agent.stalled`
instead of `agent.completed` when the loop response carries an
`[Agent stopped: …]` terminator; the guard subscribes and either
requests a retry or transitions the task to blocked.

**Two new events:**

- `agent.stalled` — emitted by the watcher when `detectStall(response)`
  returns a reason. Same payload as `agent.completed` plus
  `stallReason: string`. Lets observability plugins react to stalls
  separately from clean completions.
- `task.dispatch_requested` — emitted by the StallGuard when it wants
  the watcher to re-fire routing on a retry. Payload is
  `{ taskId; projectId?; reason: string }`. The watcher subscribes
  in its constructor and forwards to `notify({...}, { force: true })`.
  Any plugin (a future scheduler, a remote-signal handler) can emit
  this and the watcher will route accordingly.

**Behavior preserved.** Comment shape (`STALL #N: …`), retry count
(`taskWatcher.maxStallRetries`, default 1), decompose-hint on block,
500ms delay before re-fire — all identical to the old watcher path.
On the out-of-retries branch the guard re-emits `agent.completed` with
the new `finalTask.status = "blocked"` so the DiscordNotifier (which
only subscribes to `agent.completed`) still sees the terminal
transition. StallGuard subscribes to `agent.stalled` only, so the
re-emit doesn't loop.

- New `packages/core/src/plugins/stall-guard.ts` with `StallGuard`,
  `countPriorStalls`, and `formatStallComment`. Constructor accepts
  an optional `maxStallRetries` override for tests.
- Watcher drops `handleStall`, `formatStallComment`,
  `summarizeWorktreeChanges`, and the unused `STALL_COMMENT_PREFIX`
  helper from inside the class. `detectStall` stays exported.
- `TaskWatcher` subscribes to `task.dispatch_requested` in its
  constructor and disposes on `stop()`.
- CLI constructs `new StallGuard({ runtime })` alongside the other
  default plugins and stops it on shutdown.

10 new tests in `stall-guard.test.ts` cover retry, block, re-emit,
override, lifecycle. Pre-existing handleStall + formatStallComment
tests removed from `task-watcher-notification.test.ts` (they exercised
the now-deleted watcher private API). 1408 tests pass overall (was
1405).
