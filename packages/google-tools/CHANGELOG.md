# @tailored-ai/google-tools

## 0.1.10

### Patch Changes

- 4c6b194: A missing `gog` binary is reported as a missing binary, not as a Gmail failure.

  Every tool in this package shells out to the `gog` CLI and reports failures as
  `stderr || "gog <verb> failed"`. A spawn failure produces **no stderr**, so the
  fallback fires and an agent is told `gog gmail search failed` — which names the
  wrong subsystem and reads as an API or credential problem.

  What that cost in one deployment: six days of a monitoring room diagnosing an
  OAuth token. The first failures genuinely were `oauth2: "invalid_grant"`, with
  gog installed and its credentials expired. Later the binary went missing, stderr
  went empty, the message silently changed to the generic one, and five successive
  diagnoses kept chasing the token because nothing ever said the command did not
  exist.

  ENOENT and EACCES now surface as their own messages, the ENOENT one stating
  outright that this is not an authentication problem, and pointing at install plus
  `gog auth login`. Ordinary non-zero exits are untouched — gog's own stderr is
  still the better message when gog actually ran.

- Updated dependencies [b559646]
- Updated dependencies [ef9e809]
- Updated dependencies [a2f8016]
- Updated dependencies [ed98f4a]
- Updated dependencies [b559646]
- Updated dependencies [920a799]
- Updated dependencies [fecc3d8]
- Updated dependencies [2632f51]
- Updated dependencies [9af06b7]
- Updated dependencies [b8f5d16]
- Updated dependencies [aee6802]
- Updated dependencies [9d32c15]
- Updated dependencies [8b0c45a]
- Updated dependencies [f67b15a]
- Updated dependencies [7447619]
- Updated dependencies [fd84749]
- Updated dependencies [b559646]
- Updated dependencies [d9e294f]
- Updated dependencies [b1ec29a]
- Updated dependencies [fd19549]
- Updated dependencies [a38b5fc]
- Updated dependencies [1206560]
- Updated dependencies [0a3b591]
- Updated dependencies [dc312f1]
- Updated dependencies [5a01ceb]
- Updated dependencies [b1cdad9]
- Updated dependencies [0fb08f4]
- Updated dependencies [0fb08f4]
- Updated dependencies [0fb08f4]
- Updated dependencies [54ce46f]
- Updated dependencies [7017c2d]
- Updated dependencies [7d273b5]
- Updated dependencies [b559646]
- Updated dependencies [e6cb5fb]
- Updated dependencies [e66f07b]
- Updated dependencies [0187e0c]
- Updated dependencies [b559646]
- Updated dependencies [daa6302]
- Updated dependencies [a970a8b]
- Updated dependencies [57a5d48]
- Updated dependencies [39445bb]
- Updated dependencies [4c48ad8]
- Updated dependencies [ba7bad5]
- Updated dependencies [571adba]
- Updated dependencies [de1ce69]
- Updated dependencies [87fc6fd]
- Updated dependencies [611f94d]
- Updated dependencies [8aa5720]
- Updated dependencies [d2b5939]
- Updated dependencies [7e9a130]
- Updated dependencies [b559646]
- Updated dependencies [d3a4cf1]
- Updated dependencies [36a50b7]
- Updated dependencies [4656518]
- Updated dependencies [d3e79e3]
- Updated dependencies [128c561]
- Updated dependencies [30a0c14]
- Updated dependencies [df2d055]
- Updated dependencies [9ccec1f]
- Updated dependencies [e698f39]
- Updated dependencies [b8fe10c]
- Updated dependencies [0d4f4b6]
- Updated dependencies [6460c00]
- Updated dependencies [0039c3a]
- Updated dependencies [8d0f50e]
- Updated dependencies [9b13c86]
- Updated dependencies [c120f51]
- Updated dependencies [7c6217a]
- Updated dependencies [449e827]
- Updated dependencies [58dd367]
- Updated dependencies [bbcde3b]
- Updated dependencies [2c0fde1]
- Updated dependencies [0b7a0f7]
- Updated dependencies [19188db]
- Updated dependencies [20f9fe1]
- Updated dependencies [7f620a0]
- Updated dependencies [b559646]
- Updated dependencies [9883913]
- Updated dependencies [77781ef]
- Updated dependencies [b7788ad]
- Updated dependencies [7e05a94]
- Updated dependencies [e3b1bc5]
- Updated dependencies [920a799]
- Updated dependencies [920a799]
- Updated dependencies [b559646]
- Updated dependencies [682e304]
- Updated dependencies [d492806]
- Updated dependencies [dd3951c]
- Updated dependencies [544aac2]
- Updated dependencies [87d2af3]
- Updated dependencies [c308241]
- Updated dependencies [cc792f2]
- Updated dependencies [7d273b5]
- Updated dependencies [42a1e90]
- Updated dependencies [2963457]
- Updated dependencies [9ec3100]
- Updated dependencies [248931d]
- Updated dependencies [4b54275]
- Updated dependencies [22f9b9e]
- Updated dependencies [d7656d8]
- Updated dependencies [afc05a2]
- Updated dependencies [dd3951c]
- Updated dependencies [1ad506a]
- Updated dependencies [a1231c6]
- Updated dependencies [1d9e6a6]
- Updated dependencies [f0bb132]
- Updated dependencies [19996ac]
- Updated dependencies [28bb474]
- Updated dependencies [244cdcf]
- Updated dependencies [a00b73a]
- Updated dependencies [b559646]
- Updated dependencies [c50e55a]
- Updated dependencies [bcc2159]
- Updated dependencies [42d98c6]
- Updated dependencies [b8a8da4]
- Updated dependencies [cf2cd34]
  - @tailored-ai/core@0.1.10

## 0.1.9

### Patch Changes

- Updated dependencies [4f992c9]
  - @tailored-ai/core@0.1.9

## 0.1.8

### Patch Changes

- 14fdab3: The `tools` config section is now an open map (`[toolId: string]: { enabled?: boolean; ... }`): plugin tools read `tools.<id>` through the index instead of needing typed slots in core. The `gmail` / `google_calendar` / `google_drive` shapes move out of core's `AgentConfig` into `@tailored-ai/google-tools`, and `validateConfig` no longer special-cases those tool ids (the plugin already warns and skips at factory time when `account` is missing).
- f240f5e: Plugin self-description and config validation: optional `meta` and `validateConfig` named exports on plugin modules, captured by the loader onto `LoadedPlugin`, surfaced via the new `GET /api/plugins` route and startup warnings. `tai plugin list` shows package descriptions. The builtin plugins, channel-slack, and google-tools ship reference `meta`/`validateConfig` implementations.
- Updated dependencies [c67120e]
- Updated dependencies [ecb0d69]
- Updated dependencies [a6e26a4]
- Updated dependencies [e0b9bbe]
- Updated dependencies [c83c58c]
- Updated dependencies [e4e239f]
- Updated dependencies [d398c93]
- Updated dependencies [c71e7de]
- Updated dependencies [08ac997]
- Updated dependencies [ef7fe84]
- Updated dependencies [ff81e89]
- Updated dependencies [290f96d]
- Updated dependencies [04181f5]
- Updated dependencies [330a6c5]
- Updated dependencies [d927a26]
- Updated dependencies [02c0a5a]
- Updated dependencies [98160f3]
- Updated dependencies [14fdab3]
- Updated dependencies [ba79819]
- Updated dependencies [04181f5]
- Updated dependencies [f240f5e]
- Updated dependencies [10bfad3]
- Updated dependencies [c759128]
- Updated dependencies [a655023]
- Updated dependencies [877795c]
- Updated dependencies [773e16c]
- Updated dependencies [1747dbe]
- Updated dependencies [ef1e01c]
- Updated dependencies [cdc0034]
  - @tailored-ai/core@0.1.8

## 1.0.1

### Patch Changes

- Updated dependencies [e568706]
  - @tailored-ai/core@1.0.1

## 1.0.0

### Patch Changes

- Updated dependencies [274de6f]
  - @tailored-ai/core@1.0.0

## 0.1.6

### Patch Changes

- Updated dependencies [4201cc9]
- Updated dependencies [4201cc9]
- Updated dependencies [4201cc9]
  - @tailored-ai/core@0.1.6

## 0.1.5

### Patch Changes

- Updated dependencies [b443c8e]
  - @tailored-ai/core@0.1.5

## 0.1.4

### Patch Changes

- Updated dependencies [b163368]
  - @tailored-ai/core@0.1.4

## 0.1.3

### Patch Changes

- Updated dependencies [41bea5c]
  - @tailored-ai/core@0.1.3

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

- Updated dependencies [d2733dc]
- Updated dependencies [a6d5d9b]
- Updated dependencies [74bc27d]
  - @tailored-ai/core@0.1.2

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
