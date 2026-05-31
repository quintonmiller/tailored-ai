---
"@tailored-ai/browser-mediator": minor
"@tailored-ai/core": minor
"@tailored-ai/server": minor
"@tailored-ai/cli": minor
"@tailored-ai/google-tools": minor
"@tailored-ai/trusted-actions": minor
---

Initial public release.

- `@tailored-ai/core` — agent runtime, config, tools, providers, channels, db, cron, hooks.
- `@tailored-ai/server` — Hono-based HTTP API with SSE streaming and webhooks.
- `@tailored-ai/cli` — `tai` command, REPL + one-shot + project management + bundled web UI.
- `@tailored-ai/browser-mediator` — framework-agnostic bounded browser tool with egress allow-list, vault `$ref` expansion, output sanitiser, always-HITL gates. Ships with OpenAI / Anthropic / TAI adapters.
- `@tailored-ai/google-tools` — Gmail, Google Calendar, Google Drive tools that register via `@tailored-ai/core`'s tool-factory registry.
- `@tailored-ai/trusted-actions` — HITL gateway for risky agent actions; approval over web-push to a phone PWA, executor runs in a hermetic Docker container.
