# @tailored-ai/channel-slack

## 0.1.10

### Patch Changes

- 57a5d48: Add a global pause switch: `/pause` and `/resume` in Discord.

  Two agents on a metered API answered each other unattended and spent real money
  in twenty minutes, and there was no way to stop it from a phone. Killing the
  process loses in-flight work, editing config calls `runtime.reload()` and
  bounces the very Discord gateway you are typing into, and `autopilot pause`
  covers one of six things that can start a run.

  **`/pause` blocks autonomous runs only.** Cron timers, webhooks, all eight
  workflow trigger pollers, autopilot, exploratory ticks, task auto-dispatch and
  stall retries, room check-ins, agent-to-agent wakes and DMs. Your own messages
  keep working on purpose: a pause that also kills your DMs is indistinguishable
  from an outage, and it removes the instruments you would use to inspect what
  went wrong. `/pause scope:all` adds human-initiated runs.

  **In-flight runs finish.** The gate refuses new runs; aborting a half-finished
  tool call turns an expensive mistake into an expensive mistake plus an
  inconsistent worktree. Child workflows started by a running parent are treated
  as continuations for the same reason.

  State lives in a new `runtime_settings` singleton table, read live on every
  check — the same shape as `autopilot_settings`, and in SQLite rather than
  config for the reload reason above. `AgentRuntime` gains
  `isAgentsPaused(kind)`, `getPauseState()` and `setAgentsPaused()`, and a real
  change emits `agents.pause_changed` on the runtime bus.

  Server, CLI and Slack are touched only to refuse politely under `scope: all`,
  plus one gate in core's own webhook `action: agent` route, which reaches the
  agent loop without passing through the workflow engine.

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
