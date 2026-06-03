---
"@tailored-ai/core": minor
"@tailored-ai/channel-slack": patch
---

**Refactor:** Channel contract polish (#41). Three small smells from PR #35 resolved in one pass.

- **`runtime.defaultLoopObservers({ prefix })`**: new helper that returns the standard `onToolCall` / `onApprovalRequest` / `onApprovalResponse` `console.log` callbacks. Discord (two call sites) and Slack used to hand-roll identical handlers — they now opt in via `{...runtime.defaultLoopObservers({ prefix })}` so a future format change happens in one place. Tool-call args truncate at 200 chars to keep logs scannable.
- **`Channel.indicateWorking?(target): () => void`**: new optional capability. Channels with a "typing" or "thinking" affordance implement it; consumers wrap their work in `const stop = ch.indicateWorking?.(target); try { ... } finally { stop?.(); }`. The Discord channel implements it on top of `sendTyping`; the existing inline keep-alive timer in `handleMessageWithContent` is gone in favor of the new method.
- **`Channel.onMessage` dropped**: the hook was never called from production code — the field was always undefined and the emit paths in Discord and Slack were dead. Removed from the `Channel` interface, the contract test, and both reference channels. Channel authors that want an external observer should hang one off their own transport.

**Breaking change** for external channels: implementations no longer need (and must not provide) an `onMessage` method on the `Channel` interface. The compiler will catch this — adopting the new shape is a one-line delete.
