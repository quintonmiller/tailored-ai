---
"@tailored-ai/core": patch
---

Add the `builtin:session-summarizer` plugin — cross-channel continuity, shipped
disabled by default.

Sessions are hermetic per-channel silos (`discord:<user>`, `web:<key>`), and
nothing summarized an idle session, so a new session on a different channel
started cold. This opt-in plugin runs a periodic sweep (`sweepIdleSessions`)
that summarizes idle sessions, then refreshes the always-injected
`recent_summary` core-memory section — the channel-agnostic layer the agent
loop reads on every turn — so the next session anywhere sees what recently
happened. Composed from the most recent summaries (newest first), hard-capped
(~600 bytes) so the always-injected layer stays small for local models.

It autonomously calls the LLM and writes memory, so it ships `enabled: false`
(new `DEFAULT_DISABLED_PLUGIN_MODULES` tier; `migrateDefaultPlugins` seeds it
disabled and never flips a user's opt-in back off). No behavior change for
anyone who doesn't enable it. Knobs (`intervalMinutes`, `idleMinutes`,
`maxPerSweep`, `keyPrefixes`, `updateRecentSummary`, `recentSummaryCount`,
`recentSummaryMaxBytes`) come from the plugin's `config` bag.

Also adds `sessionId` to `SummarizeSessionResult` so sweep callers can map a
result back to its source session.
