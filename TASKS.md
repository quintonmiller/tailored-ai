# Tasks

## Phase 1: Core Agent
- [x] Project setup (TypeScript, ESM, SQLite, config system)
- [x] Ollama provider (`/api/chat` with tool calling)
- [x] Core tools: `exec`, `read`, `write`
- [x] Agent loop with multi-round tool calling
- [x] CLI: interactive REPL, `--message` single-shot, `--json` output
- [x] `.env` support via dotenv

## Phase 2: Discord + Persistence
- [x] Discord bot integration (DMs + @mentions)
- [x] `--serve` mode for running as a service
- [x] Per-user session management (keyed sessions in SQLite)
- [x] Message history persistence
- [x] Typing indicator while processing
- [x] Long message splitting (>2000 chars)
- [ ] Handle Discord reconnects / error recovery gracefully
- [ ] Guild channel allowlist testing (currently only DMs tested end-to-end)

## Phase 3: Sub-agents + Cron
- [ ] Sub-agent spawning (isolated context, cheaper model)
- [ ] Model routing (different models for different task types)
- [ ] Cron job scheduler
- [ ] Background task management

## Phase 4: Web UI + Polish
- [ ] HTTP server (Fastify/Hono)
- [ ] REST API for management (sessions, config, health)
- [ ] Minimal dashboard (status, logs, active sessions)
- [ ] OpenAI provider
- [ ] `web_search` tool (Brave API)
- [ ] `web_fetch` tool (URL fetching + HTML parsing)

## Phase 5: Extensibility
- [ ] YAML/JSON skill definitions with per-skill prompts
- [ ] Additional channels (Slack, Telegram)
- [ ] Webhook receiver (Gmail, GitHub, etc.)
- [ ] Chat UI in dashboard

## Bugs / Tech Debt
- [ ] Database path resolves relative to CWD, not project root - consider making it absolute or relative to config file location
- [ ] No history compaction yet - sessions will grow unbounded (spec says max 2000 tokens history)
- [ ] Both OpenClaw and autonomous-agent share the same Discord bot token - will need separate bot apps for production use
- [ ] No unit tests yet
