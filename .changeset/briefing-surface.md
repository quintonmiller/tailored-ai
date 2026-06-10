---
"@tailored-ai/core": patch
"@tailored-ai/server": patch
"@tailored-ai/ui": patch
---

Add a config-gated Home "briefing" surface: an LLM-written greeting/summary of
what happened, what needs the owner, and what's coming up.

- core: `generateBriefing(runtime)` assembles a compact, data-only context from
  existing dashboard queries (blocked tasks, recently completed tasks + workflow
  runs in the last 24h, enabled cron jobs, recent `session-summary` notes), caps
  each list and the total length, then runs ONE provider completion using the
  system prompt from `config.briefing.prompt`. New `briefing` config block ships
  disabled by default (`{ enabled: false, prompt: <generic default>, ttlMinutes: 30 }`).
- server: `GET /api/briefing` returns `{ enabled: false }` with no provider call
  when disabled; when enabled it serves a fresh cached briefing (TTL) or generates
  one (in-memory cache, single-flight guard). `POST /api/briefing/refresh` forces
  a regenerate and 429s if one is already running.
- ui: Home renders a briefing card at the top when the feature is enabled, with
  relative timestamp and a refresh button; renders nothing when disabled.

No behavior or token cost unless `briefing.enabled` is set.
