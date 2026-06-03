# @tailored-ai/google-tools

## 0.1.1

### Patch Changes

- dddf565: Migrate `@tailored-ai/google-tools` to the `register(ctx)` plugin contract (closes #55). The package previously registered Gmail / GoogleCalendar / GoogleDrive via module-load side effects, which broke when installed via `tai plugin install` outside the host's resolution tree (same class of bug as channel-slack pre-#47). Default export is now a `Plugin` function the host invokes with a `PluginContext`. CLI drops its `@tailored-ai/google-tools` workspace dep — Google tools are now fully optional, opt-in via `plugins: ["@tailored-ai/google-tools"]` in config.yaml.
- f585b70: Release build now covers every publishable package (closes #56). The root `build` script previously enumerated packages by hand and forgot `channel-slack` and `google-tools`; `pnpm publish -r` would have shipped them with stale or missing `dist/` output. Build is now `pnpm -r run build` and the release workflow runs a new `pnpm run pack:check` smoke that packs every public package and asserts each tarball contains `dist/index.js`. The Changesets fixed group adds `channel-slack` and `google-tools` so they version in lockstep with `core`'s plugin contract.
- c87fce0: Initial public release.

  - `@tailored-ai/core` — agent runtime, config, tools, providers, channels, db, cron, hooks.
  - `@tailored-ai/server` — Hono-based HTTP API with SSE streaming and webhooks.
  - `@tailored-ai/cli` — `tai` command, REPL + one-shot + project management + bundled web UI.
  - `@tailored-ai/browser-mediator` — framework-agnostic bounded browser tool with egress allow-list, vault `$ref` expansion, output sanitiser, always-HITL gates. Ships with OpenAI / Anthropic / TAI adapters.
  - `@tailored-ai/google-tools` — Gmail, Google Calendar, Google Drive tools that register via `@tailored-ai/core`'s tool-factory registry.
  - `@tailored-ai/trusted-actions` — HITL gateway for risky agent actions; approval over web-push to a phone PWA, executor runs in a hermetic Docker container.

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
