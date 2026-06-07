# @tailored-ai/core

## 0.1.4

### Patch Changes

- b163368: Wire task lifecycle emissions onto the runtime event bus — Slice 2 of
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

  - @tailored-ai/browser-mediator@0.1.4

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

  - @tailored-ai/browser-mediator@0.1.3

## 0.1.2

### Patch Changes

- d2733dc: GitHub task backend routes TAI agent-role assignees (coder, reviewer,
  planner, etc.) through `agent:<role>` labels instead of GitHub's
  `assignees` API. GitHub rejects `assignees: ["coder"]` with 422 because
  "coder" isn't a real collaborator, which previously prevented the
  backend from creating any task assigned to an agent role.

  - New `tasks.github.agentRoles` config option to extend the built-in
    set of agent names (defaults cover the standard TAI agents).
  - Real GitHub usernames still go through the assignees API.
  - Reads round-trip cleanly: `toTask` prefers the `agent:*` label, falls
    back to the first GH assignee.
  - `query` and `nextBacklogTask` filter by label when the requested
    assignee is an agent role.

- a6d5d9b: Project overlays (`.tai.yaml`) now have `${ENV}` references interpolated
  before merging onto the global config. Previously a per-project overlay
  that referenced `${GITHUB_PERSONAL_TOKEN}` in `tasks.github.token`
  reached the GitHub task backend as the literal string
  `${GITHUB_PERSONAL_TOKEN}`, producing `Bad credentials` on every Octokit
  call. The base config has always been interpolated by `loadConfig`; the
  overlay path skipped this step entirely.

  Fix applies in `mergeProjectOverlay` itself so every overlay consumer
  (per-project task backends, the active-project runtime overlay, etc.)
  benefits without each caller having to remember to interpolate.

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

  - @tailored-ai/browser-mediator@0.1.2

## 0.1.1

### Patch Changes

- e0fd7d4: **Security:** Centralized SSRF / outbound-HTTP egress policy at `packages/core/src/security/egress-policy.ts`. Applied to `web_fetch` and the workflow `http_request` step. By default, loopback, RFC1918, IPv6 ULA (fc00::/7), link-local (169.254/16, fe80::/10), carrier-grade NAT (100.64/10), unspecified, and cloud metadata endpoints (169.254.169.254, fd00:ec2::254, fe80::a9fe:a9fe) are denied. DNS is resolved before fetch so a hostname that resolves to a private IP gets caught — including the multi-A-record case where one leg is public and another is private. Operators opt back into internal targets via `security.egress.allowHosts` / `allowPrivateNetworks` / `allowMetadataEndpoints` in `config.yaml`, or turn the policy off entirely with `disabled: true` (loud `validateConfig` warning fires when set). Closes #57.

  **Known limitation**: DNS-rebinding is not addressed (the policy resolves DNS, the fetch resolves separately). A follow-up will pin fetch to the resolved IP via a custom Undici dispatcher.

- 6e56681: **Refactor:** Centralize the session-key convention on `AgentRuntime` (#39). Channels used to hand-roll `${id}:${user}` and `${id}:${projectId}:${user}` strings — three lines in Discord, one in Slack, one in `task-watcher.ts`. Downstream consumers (autopilot, task-watcher) prefix-matched the raw strings, which silently broke when one channel drifted on field order.

  Two helpers now own the format:

  ```ts
  runtime.makeSessionKey({ channelId, userId, project?: ProjectRef | null }): string
  runtime.parseSessionKey(key): { channelId, userId, projectId?: string } | undefined
  ```

  Format guarantees documented in the JSDoc: `<channelId>:<userId>` or `<channelId>:<projectId>:<userId>`. `make` rejects inputs containing the `:` delimiter (would corrupt round-trip). `parse` returns `undefined` for unrecognized shapes so callers can ignore freeform CLI/web session ids without throwing.

  Migrated: Discord (3 call sites), Slack (1), `task-watcher.ts`'s Discord-owner fallback (1).

- 268041a: **Refactor:** Channel contract polish (#41). Three small smells from PR #35 resolved in one pass.

  - **`runtime.defaultLoopObservers({ prefix })`**: new helper that returns the standard `onToolCall` / `onApprovalRequest` / `onApprovalResponse` `console.log` callbacks. Discord (two call sites) and Slack used to hand-roll identical handlers — they now opt in via `{...runtime.defaultLoopObservers({ prefix })}` so a future format change happens in one place. Tool-call args truncate at 200 chars to keep logs scannable.
  - **`Channel.indicateWorking?(target): () => void`**: new optional capability. Channels with a "typing" or "thinking" affordance implement it; consumers wrap their work in `const stop = ch.indicateWorking?.(target); try { ... } finally { stop?.(); }`. The Discord channel implements it on top of `sendTyping`; the existing inline keep-alive timer in `handleMessageWithContent` is gone in favor of the new method.
  - **`Channel.onMessage` dropped**: the hook was never called from production code — the field was always undefined and the emit paths in Discord and Slack were dead. Removed from the `Channel` interface, the contract test, and both reference channels. Channel authors that want an external observer should hang one off their own transport.

  **Breaking change** for external channels: implementations no longer need (and must not provide) an `onMessage` method on the `Channel` interface. The compiler will catch this — adopting the new shape is a one-line delete.

- 4552f5e: Add `runChannelContractSuite` test helper at the `@tailored-ai/core/testing` subpath. Channel authors plug a small harness (build / emitIncoming / drainSent) into the helper and get the Channel contract assertions (id/type, connect/disconnect, send round-trip, onMessage observer, plugin registration) for free instead of re-deriving them from Discord's source. `vitest` is now an optional peer of `@tailored-ai/core` — only consumed by the `/testing` subpath. `channel-slack` adopts the suite as its smoke coverage.
- e7eeeec: Channel hot-reload now reconciles per-channel state via a new `ChannelLifecycleManager`. Previously, toggling `channels.discord.enabled` on reload called `startRegisteredChannels(runtime)` again — which re-invoked every registered factory, including ones whose channel was already running. A second Slack Bolt app would attach to Socket Mode while the first kept listening, so every incoming message fired the agent loop twice. The lifecycle manager keys by channel id, treats reload as a set-difference (start new, stop removed, restart on config change), and exposes `get(id)` / `list()` / `stopAll()`. Closes #58.
- 3137e3d: ExecTool now resolves its scratch directory (where truncated command output is persisted) from `$TAI_HOME` / a constructor override / `~/.tai` in that order — the hardcoded `~/.tai/exec-outputs` path used to silently ignore configured TAI homes. The truncation path is also wrapped in `try/catch` so a filesystem failure (permission denied, missing $HOME on a CI runner, sandbox without write access) returns visible truncated output with a "could not be persisted" warning instead of leaving the tool promise unsettled until the timeout fires. Closes #60.
- 3b5c2c4: CI now runs `pnpm run lint` and `pnpm run pack:check` on every PR (closes #68 — error-enforcement portion). The lint baseline is cleared of all blocking errors (1 unreachable-code error in `channel-slack`'s test fixed; ~30 errors auto-fixed by `biome check --write`). 197 advisory warnings remain — predominantly UI a11y findings tracked under #93 — and don't block CI.
- d89b679: **Security:** Filesystem `allowedPaths` checks in `ReadTool` and `WriteTool` now use a proper path-containment helper instead of `startsWith`. Previously, allowing `/srv/project` also permitted `/srv/project-secrets` (sibling-prefix), and a symlink inside an allowed directory pointing at `/etc/passwd` would let the read/write tools escape the sandbox. The new `isPathContainedRealpath` helper normalizes paths, requires a true descendant boundary, and resolves symlinks (with nearest-existing-parent resolution for write targets that don't exist yet). Closes #59.
- c6ee302: **Fix:** `recall list` now returns notes in deterministic newest-first order, even when many notes share the same `created_at` second. SQLite's `datetime('now')` is second-precision, and the previous tiebreak — `id DESC` where the id is `note_${randomHex}` — was _not_ monotonic in insertion order. Two notes written in the same tick came back in arbitrary order. The query now tiebreaks on `rowid DESC` (SQLite's implicit monotonic insertion counter), giving sub-second deterministic ordering with no schema migration. Closes #63.
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
- 2c651b4: **Fix:** Workflow steps now anchor to the active project root instead of the server's `process.cwd()`. The `WorkflowEngine` snapshots `runtime.getActiveProject()?.path` at the start of every run and threads it onto each step's `StepContext.projectPath`. The `shell`, `tool_call`, and `worktree` executors and the run-level sandbox `prepare` all prefer this over their constructor-default cwd, so a workflow launched from any directory (CLI, channel, cron, HTTP) runs against the intended project files. Explicit `step.cwd` / `worktree.repoDir` continue to win. The path is captured once per run, so `setActiveProject` mid-run doesn't reroute in-flight steps. Closes #64.
- 5b19bd7: Workflow loader now drives trigger validation from the trigger registry instead of a closed allowlist. Built-in pollers (`geofence`, `weather`, `sensor`, `finance`, `home_assistant`) were rejected by the loader despite being in `BUILTIN_TRIGGER_KINDS` and wired into the runtime — they now load cleanly. `validateWorkflow` and `loadWorkflowsFromDir` accept an optional `allowedTriggerKinds` for plugin-supplied trigger kinds. `WorkflowRegistry.setExtraTriggerKinds(supplier)` lets the runtime feed the active registry's kinds in. Closes #54.
- Updated dependencies [f585b70]
- Updated dependencies [c87fce0]
  - @tailored-ai/browser-mediator@0.1.1
