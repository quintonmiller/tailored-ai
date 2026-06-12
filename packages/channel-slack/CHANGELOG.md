# @tailored-ai/channel-slack

## 0.1.8

### Patch Changes

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

- Updated dependencies [d2733dc]
- Updated dependencies [a6d5d9b]
- Updated dependencies [74bc27d]
  - @tailored-ai/core@0.1.2

## 0.1.1

### Patch Changes

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
- 3b5c2c4: CI now runs `pnpm run lint` and `pnpm run pack:check` on every PR (closes #68 — error-enforcement portion). The lint baseline is cleared of all blocking errors (1 unreachable-code error in `channel-slack`'s test fixed; ~30 errors auto-fixed by `biome check --write`). 197 advisory warnings remain — predominantly UI a11y findings tracked under #93 — and don't block CI.
- f585b70: Release build now covers every publishable package (closes #56). The root `build` script previously enumerated packages by hand and forgot `channel-slack` and `google-tools`; `pnpm publish -r` would have shipped them with stale or missing `dist/` output. Build is now `pnpm -r run build` and the release workflow runs a new `pnpm run pack:check` smoke that packs every public package and asserts each tarball contains `dist/index.js`. The Changesets fixed group adds `channel-slack` and `google-tools` so they version in lockstep with `core`'s plugin contract.
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
