# @tailored-ai/trusted-actions

## 0.1.9

### Patch Changes

- Updated dependencies [4f992c9]
  - @tailored-ai/core@0.1.9

## 0.1.8

### Patch Changes

- e4e239f: Plugin-mounted HTTP routes; move trusted-actions endpoints out of the core
  server (#206).

  Plugins can now mount HTTP routes on the TAI server through a framework-agnostic
  seam. Core owns a runtime `HttpRouteRegistry` of descriptors
  (`{ method, path, handler, auth?, absolute? }`) where the handler takes a simple
  `TaiHttpRequest` and returns a `TaiHttpResponse` — core never imports Hono.
  Plugins register via `ctx.http.register(...)` / `ctx.http.mount(prefix, ...)`,
  namespaced under `/api/ext/<plugin-id>/…` so they can't shadow core routes. An
  opt-in `absolute: true` escape hatch mounts a verbatim path for first-party
  packages preserving a legacy path; `auth: "none"` exempts a route from the
  server bearer check for service-called webhooks. The server iterates the
  registry after building its Hono app (`mountPluginHttpRoutes`) inside the
  existing `server.authToken` middleware; routes register at startup and survive
  reload (the registry persists; handlers read live runtime state).

  The Amazon-specific `/api/trusted-actions/*` endpoints (executor pass-throughs +
  the executor → TAI callback) move out of `@tailored-ai/server` into
  `@tailored-ai/trusted-actions` (`./plugin` subpath), registered through the new
  seam — the dogfood for the contract. They keep their historical paths via
  `absolute: true`, so the UI keeps working; the callback keeps its exact
  shared-secret auth via `auth: "none"`. The CLI auto-loads the route plugin as a
  runtime-context plugin when `trustedActions.enabled`, with the package as an
  `optionalDependencies`.

  No behavior change for existing deployments: the same endpoints respond at the
  same paths with unchanged auth.

- 3615d6f: Align playwright dependency with browser-mediator (^1.49.0 → ^1.58.2).
- 5914dbf: Stealth browser contexts no longer hardcode `en-US` / `America/Los_Angeles`. Locale and timezone are captured at `setup amazon` login time, stored in the session, and replayed; sessions saved before this change fall back to the executor host's locale/timezone. The `navigator.languages` patch now derives from the effective locale.
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

- Updated dependencies [d2733dc]
- Updated dependencies [a6d5d9b]
- Updated dependencies [74bc27d]
  - @tailored-ai/core@0.1.2

## 0.1.1

### Patch Changes

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
