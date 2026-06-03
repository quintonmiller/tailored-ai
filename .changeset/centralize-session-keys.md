---
"@tailored-ai/core": patch
"@tailored-ai/channel-slack": patch
---

**Refactor:** Centralize the session-key convention on `AgentRuntime` (#39). Channels used to hand-roll `${id}:${user}` and `${id}:${projectId}:${user}` strings — three lines in Discord, one in Slack, one in `task-watcher.ts`. Downstream consumers (autopilot, task-watcher) prefix-matched the raw strings, which silently broke when one channel drifted on field order.

Two helpers now own the format:

```ts
runtime.makeSessionKey({ channelId, userId, project?: ProjectRef | null }): string
runtime.parseSessionKey(key): { channelId, userId, projectId?: string } | undefined
```

Format guarantees documented in the JSDoc: `<channelId>:<userId>` or `<channelId>:<projectId>:<userId>`. `make` rejects inputs containing the `:` delimiter (would corrupt round-trip). `parse` returns `undefined` for unrecognized shapes so callers can ignore freeform CLI/web session ids without throwing.

Migrated: Discord (3 call sites), Slack (1), `task-watcher.ts`'s Discord-owner fallback (1).
