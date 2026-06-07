---
"@tailored-ai/core": patch
"@tailored-ai/cli": patch
---

Extract coder/reviewer project_id guardrail out of TaskWatcher into a
`CoderProjectGuard` default plugin — Slice 3 step 4 of the platform
vision (`docs/platform-vision.md`). The watcher emits `agent.dispatched`
via `bus.emitAsync(...)`; the guard subscribes and returns `false` to
veto when a coder or reviewer is about to dispatch without an isolated
worktree. Watcher honours the veto and skips the dispatch.

**New EventBus capability: `emitAsync` with veto semantics.**

`EventBus.emitAsync<K>(event, payload): Promise<boolean>` is the
synchronous-causality variant of `emit`. It awaits every subscriber
(sequentially, in registration order) and returns:

- `true` when no handler vetoed
- `false` when any handler returned `false`

A throwing handler is logged and treated as non-veto, so a buggy
observability plugin can't accidentally block real work. The handler
type widens to `void | boolean | Promise<void | boolean>` —
`undefined`/`true` returns are equivalent and the common case stays
side-effect-only.

**New event: `agent.dispatched`.**

Payload `{ taskId, projectId, agentName, task }`. Fired by the watcher
*before* it starts the agent loop; the guard's veto causes the watcher
to skip resolveAgent / session setup / worktree creation / loop
entirely. Same hard guarantee the watcher used to enforce inline.

- New `packages/core/src/plugins/coder-project-guard.ts` with
  `CoderProjectGuard`. On veto, writes a BLOCKED comment + transitions
  the task to `blocked` (same shape the watcher used to write).
- Watcher drops the two inline guard checks (~36 LOC), removes the
  now-unused `addTaskComment`/`updateProjectTask` imports and the
  `WATCHER_COMMENT_AUTHOR` constant.
- CLI constructs `new CoderProjectGuard({ runtime })` alongside the
  other defaults; stops on shutdown.

11 new tests in `coder-project-guard.test.ts` cover the veto path
(missing project_id, missing project path), the allow path (non-coder
agents, valid project, default routing), `stop()` lifecycle, and the
new `TypedEventBus.emitAsync` (empty subscribers, void/true returns,
explicit false veto, sequential ordering, throw-as-non-veto).
Pre-existing watcher tests construct the guard so the same invariants
remain pinned. 1419 tests pass overall.

This closes Slice 3 of the platform vision. Slices 1, 2, 3, 5 are
shipped; Slice 4 (RepoBackend / Notifier / ApprovalSurface contracts)
follows.
