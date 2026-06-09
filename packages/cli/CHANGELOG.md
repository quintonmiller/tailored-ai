# @tailored-ai/cli

## 1.0.0

### Patch Changes

- Updated dependencies [274de6f]
  - @tailored-ai/core@1.0.0
  - @tailored-ai/server@1.0.0

## 0.1.6

### Patch Changes

- 4201cc9: Extract coder/reviewer project_id guardrail out of TaskWatcher into a
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
  _before_ it starts the agent loop; the guard's veto causes the watcher
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

- 4201cc9: Extract scope-creep flagging out of TaskWatcher into a
  `ScopeCreepFlagger` default plugin — Slice 3 step 2 of the platform
  vision (`docs/platform-vision.md`). The plugin subscribes to
  `agent.completed` and, when the coder hands off a worktree branch to
  the reviewer, scans the branch's commits for foreign `ptask_*` ids
  and writes a SCOPE WARNING comment when it finds any.

  **Bug fix**: the watcher's inline implementation ran git inside
  `worktree.path`, which is gone by the time the check runs on a clean
  coder→reviewer handoff (worktree.cleanup() removes the dir before the
  scope-creep block executes). The plugin now runs git in the parent
  repo and references the branch by name, so it works in both the
  preserved and cleaned-up cases. `detectScopeCreep`'s signature changes
  from `(worktreePath, expectedTaskId)` to
  `({ repoPath, branch, expectedTaskId })` to reflect this.

  - New `agent.completed` payload field: `worktree?: { repoPath,
worktreePath, branch, preservedPath }`. The watcher captures
    `worktreeRepoPath` at creation time so it can attach the parent-repo
    path to the event even after cleanup.
  - New `packages/core/src/plugins/scope-creep.ts` with
    `ScopeCreepFlagger` and a thin `writeScopeWarning` helper.
  - Watcher drops the inline scope-creep block (~26 LOC) and the
    unconditional `addTaskComment` import path that fed it.
  - CLI constructs `new ScopeCreepFlagger({ runtime })` alongside
    `new DiscordNotifier(...)` and stops both on shutdown.

  9 new tests cover the gate (3 cases that should be ignored), the
  write path (2 cases including the parent-repo-not-worktree assertion),
  git error handling, stop()/dispose, and the formatter shape.

  Slice 3 step 3 (stall guard as a plugin, using a new
  `task.dispatch_requested` event for re-fire) follows as a separate PR.

- 4201cc9: Extract stall detection + retry out of TaskWatcher into a `StallGuard`
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

- Updated dependencies [4201cc9]
- Updated dependencies [4201cc9]
- Updated dependencies [4201cc9]
  - @tailored-ai/core@0.1.6
  - @tailored-ai/server@0.1.6

## 0.1.5

### Patch Changes

- b443c8e: Extract Discord delivery out of TaskWatcher into a `DiscordNotifier`
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

- Updated dependencies [b443c8e]
  - @tailored-ai/core@0.1.5
  - @tailored-ai/server@0.1.5

## 0.1.4

### Patch Changes

- Updated dependencies [b163368]
  - @tailored-ai/core@0.1.4
  - @tailored-ai/server@0.1.4

## 0.1.3

### Patch Changes

- 41bea5c: Add a typed runtime event bus — Slice 1 of the platform vision
  (`docs/platform-vision.md`). The bus is the seam the rest of the
  plugin model gets to use: task lifecycle, runtime reloads, and the
  default behaviors that will move out of the core in later slices all
  flow through one shared pub/sub surface.

  - New `TypedEventBus` (`packages/core/src/events.ts`) with a strongly
    typed `RuntimeEventMap`. Subscribing returns a disposer; emit is
    fire-and-forget from the emitter's point of view, sync throws and
    async rejections in handlers are logged and isolated so one bad
    subscriber can't break the rest.
  - `AgentRuntime` owns a single bus instance (`runtime.events`) and
    emits `runtime.reloaded` at the end of `reload()` before clearing
    the bus for the next generation.
  - `PluginContext.events` exposes the same bus to plugins so
    `ctx.events.on(...)` lands on the runtime's wiring.
  - The CLI pre-constructs the bus before `loadPlugins` and hands the
    same instance to both `createPluginContext` and the runtime.

  No emissions are wired beyond `runtime.reloaded` yet — Slice 2 lands
  the task lifecycle events (`task.created`, `task.updated`,
  `task.transitioned`, `task.commented`), and later slices migrate the
  in-core watchers + default behaviors onto the bus.

  17 unit tests cover delivery, dispose semantics, error isolation,
  iteration safety during dispatch, listener counts, and clear().

- Updated dependencies [41bea5c]
  - @tailored-ai/core@0.1.3
  - @tailored-ai/server@0.1.3

## 0.1.2

### Patch Changes

- 185e468: Plugin loader falls back to manual exports-map resolution for pure-ESM
  plugins. Previously a plugin whose published `exports` map only declared
  the `import` condition (no `default`, no `require`, no top-level `main`)
  failed to load because `createRequire().resolve()` couldn't see the
  `import` condition. Affected `@tailored-ai/google-tools@0.1.1` —
  restarting the agent after a fresh `tai plugin install` produced
  "plugin … is not installed" even though it was.

  Two changes ship together:

  - `@tailored-ai/cli`: the plugin loader now tries `createRequire().resolve`
    first, then walks the plugin's own `package.json` exports map by hand
    (`exports["."].import` / `default` / `require`, then `module` / `main`)
    and dynamic-imports the resolved file path. Pure-ESM plugins load
    without the author having to publish a CJS-visible entry condition.
  - `@tailored-ai/google-tools`: the `exports` map now also exposes a
    `default` condition so older versions of the loader still resolve this
    package correctly via the CJS path.

  A regression test covers the pure-ESM-only layout end-to-end in the
  plugin manager's importer.

- 74bc27d: Task-watcher routes notifyById through the per-project backend resolver
  (PR #123). Previously the watcher's notifyById always looked up tasks
  via direct SQL against `project_tasks` — fine for native-backend tasks
  but invisible to GitHub-issue tasks (`gh-*` ids), which silently
  dropped out of the routing pipeline. The coder agent never ran on any
  task filed via the per-project GH backend.

  - `TasksToolNotify` callback signature gains an optional `projectId`
    argument. The tasks tool passes the calling args' `project_id` on
    every create/update/comment.
  - The CLI's `_taskWatcherRef.notifyById` accepts the new arg and
    forwards to the watcher.
  - `TaskWatcher.notifyById` uses `runtime.getTaskBackendForProject(projectId).get(id)`
    when `projectId` is supplied; the native SQL path is preserved as
    fallback for the no-projectId case.
  - Project id is injected back onto the resolved task so downstream
    worktree-path resolution finds the right repo.

  Three new tests cover the project-routed path, the native-fallback
  path, and the gracefully-empty case.

- Updated dependencies [d2733dc]
- Updated dependencies [a6d5d9b]
- Updated dependencies [74bc27d]
  - @tailored-ai/core@0.1.2
  - @tailored-ai/server@0.1.2

## 0.1.1

### Patch Changes

- e7eeeec: Channel hot-reload now reconciles per-channel state via a new `ChannelLifecycleManager`. Previously, toggling `channels.discord.enabled` on reload called `startRegisteredChannels(runtime)` again — which re-invoked every registered factory, including ones whose channel was already running. A second Slack Bolt app would attach to Socket Mode while the first kept listening, so every incoming message fired the agent loop twice. The lifecycle manager keys by channel id, treats reload as a set-difference (start new, stop removed, restart on config change), and exposes `get(id)` / `list()` / `stopAll()`. Closes #58.
- dddf565: Migrate `@tailored-ai/google-tools` to the `register(ctx)` plugin contract (closes #55). The package previously registered Gmail / GoogleCalendar / GoogleDrive via module-load side effects, which broke when installed via `tai plugin install` outside the host's resolution tree (same class of bug as channel-slack pre-#47). Default export is now a `Plugin` function the host invokes with a `PluginContext`. CLI drops its `@tailored-ai/google-tools` workspace dep — Google tools are now fully optional, opt-in via `plugins: ["@tailored-ai/google-tools"]` in config.yaml.
- 3b5c2c4: CI now runs `pnpm run lint` and `pnpm run pack:check` on every PR (closes #68 — error-enforcement portion). The lint baseline is cleared of all blocking errors (1 unreachable-code error in `channel-slack`'s test fixed; ~30 errors auto-fixed by `biome check --write`). 197 advisory warnings remain — predominantly UI a11y findings tracked under #93 — and don't block CI.
- f585b70: Release build now covers every publishable package (closes #56). The root `build` script previously enumerated packages by hand and forgot `channel-slack` and `google-tools`; `pnpm publish -r` would have shipped them with stale or missing `dist/` output. Build is now `pnpm -r run build` and the release workflow runs a new `pnpm run pack:check` smoke that packs every public package and asserts each tarball contains `dist/index.js`. The Changesets fixed group adds `channel-slack` and `google-tools` so they version in lockstep with `core`'s plugin contract.
- e434b43: **Security:** Server now binds to `127.0.0.1` by default instead of `0.0.0.0`. Previously, a default install exposed the (unauthenticated) HTTP API and dashboard to anyone on the local network. The validate-config warning that fired when `host: 0.0.0.0` was paired with no auth is still in place — it now fires only when users explicitly opt in to a non-loopback bind. To restore the prior behavior, set `server.host: 0.0.0.0` in `config.yaml` AND configure `server.authToken` or `server.proxyAuth`. The settings-editor TUI now emits loopback in newly-generated configs.
- c87fce0: Initial public release.

  - `@tailored-ai/core` — agent runtime, config, tools, providers, channels, db, cron, hooks.
  - `@tailored-ai/server` — Hono-based HTTP API with SSE streaming and webhooks.
  - `@tailored-ai/cli` — `tai` command, REPL + one-shot + project management + bundled web UI.
  - `@tailored-ai/browser-mediator` — framework-agnostic bounded browser tool with egress allow-list, vault `$ref` expansion, output sanitiser, always-HITL gates. Ships with OpenAI / Anthropic / TAI adapters.
  - `@tailored-ai/google-tools` — Gmail, Google Calendar, Google Drive tools that register via `@tailored-ai/core`'s tool-factory registry.
  - `@tailored-ai/trusted-actions` — HITL gateway for risky agent actions; approval over web-push to a phone PWA, executor runs in a hermetic Docker container.

- 26f7c92: Workflow async-trigger pollers (file_drop, email, calendar, rss, geofence, weather, sensor, finance, home_assistant) now reconcile against the live workflow registry instead of being wired once at CLI startup. New `WorkflowTriggerCoordinator` listens to registry change events and runs a per-workflow set diff: adds new triggers, removes triggers for deleted workflows, restarts triggers whose config changed, and leaves untouched any workflow whose triggers match the last signature (no duplicate timers). Each poller class gains an `unregister(workflowName)` method for the diff path. Closes #65.
- Updated dependencies [e0fd7d4]
- Updated dependencies [6e56681]
- Updated dependencies [268041a]
- Updated dependencies [4552f5e]
- Updated dependencies [e7eeeec]
- Updated dependencies [3137e3d]
- Updated dependencies [3b5c2c4]
- Updated dependencies [d89b679]
- Updated dependencies [c6ee302]
- Updated dependencies [f585b70]
- Updated dependencies [e434b43]
- Updated dependencies [c87fce0]
- Updated dependencies [26f7c92]
- Updated dependencies [2c651b4]
- Updated dependencies [5b19bd7]
  - @tailored-ai/core@0.1.1
  - @tailored-ai/server@0.1.1
