# @tailored-ai/cli

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
