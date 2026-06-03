---
"@tailored-ai/core": patch
"@tailored-ai/channel-slack": patch
---

Add `runChannelContractSuite` test helper at the `@tailored-ai/core/testing` subpath. Channel authors plug a small harness (build / emitIncoming / drainSent) into the helper and get the Channel contract assertions (id/type, connect/disconnect, send round-trip, onMessage observer, plugin registration) for free instead of re-deriving them from Discord's source. `vitest` is now an optional peer of `@tailored-ai/core` — only consumed by the `/testing` subpath. `channel-slack` adopts the suite as its smoke coverage.
