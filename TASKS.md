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
- [x] Cron job scheduler (`src/cron/scheduler.ts`, wake + note modes, delivery to log/discord)
- [x] Agent profiles (`src/agent/profiles.ts`, config-driven model/tools/instructions per profile)
- [x] Delegate tool (`src/tools/delegate.ts`, depth-1 sub-agent spawning with profiles)
- [x] Model routing via profiles (different models for different task types)
- [x] `--profile` CLI flag for using named profiles
- [x] Cron jobs support `profile` field for per-job configuration
- [x] Background task management (`src/agent/tasks.ts`, async delegate + `task_status` tool)

## Phase 3.5: Tools
- [x] `web_fetch` tool (URL fetching + HTML stripping)
- [x] `web_search` tool (Brave API)
- [x] `trello` tool (boards, lists, cards, comments)
- [x] `gmail` tool via gog CLI (search, read, send)
- [x] `google_calendar` tool via gog CLI (list_events, search, create_event)
- [x] `exec` tool (shell commands with optional allowlist)
- [x] `read` tool (file reading with optional path restrictions)
- [x] `write` tool (file writing with optional path restrictions)
- [x] `memory` tool (persistent notes in context directory)
- [x] `claude_code` tool (delegate to Claude Code CLI)
- [x] `delegate` tool (spawn sub-agents with profiles)

## Phase 4: Web UI + Polish
- [x] HTTP server (Hono with SSE-based `/api/chat`)
- [x] REST API for management (sessions, config)
- [x] Context/memory system (`src/context.ts`, loads `.md` files into system prompt)
- [x] Dashboard upgrade — 6-section layout (status, profiles, cron, tasks, context, sessions), tools page, 5 new API endpoints
- [x] OpenAI provider (`src/providers/openai.ts`, raw fetch, configurable base URL)

## Phase 5: Extensibility
- [x] Hot-reloadable runtime (`src/runtime.ts`, `fs.watch` with 500ms debounce, dynamic tool/provider per loop iteration)
- [x] Admin tool (`src/tools/admin.ts`, runtime config reads/writes, profile management)
- [x] Custom tools (`src/tools/custom.ts`, config-defined shell command templates with `{{param}}` interpolation)
- [ ] Additional channels (Slack, Telegram)
- [ ] Webhook receiver (Gmail, GitHub, etc.)
- [ ] Chat UI in dashboard

## Bugs / Tech Debt
- [ ] Database path resolves relative to CWD, not project root - consider making it absolute or relative to config file location
- [x] ~~No history compaction yet~~ — `trimHistory()` in `loop.ts` now enforces `maxHistoryTokens`
- [ ] Both OpenClaw and autonomous-agent share the same Discord bot token - will need separate bot apps for production use
- [ ] No unit tests yet

## Dashboard Improvements
- [ ] Active nav highlighting — indicate current page in header nav
- [ ] Dashboard section spacing — empty states lack `margin-bottom`, sit tight against next heading
- [ ] Context file lazy loading — `/api/context` reads all file contents upfront; defer to on-expand to avoid bloating response with large files
- [ ] Cron config+DB merge — endpoint only reads `cron_jobs` DB table; jobs defined in config that haven't run yet won't appear. Merge config jobs with DB rows
- [ ] Tool search/filter — search input on Tools page to filter long tool lists
- [ ] Relative time auto-refresh — "3m ago" timestamps are static from page load; add a timer to keep them accurate
- [ ] Loading skeletons — dashboard flashes empty states before data arrives; add skeleton placeholders
- [ ] Responsive breakpoints — profile grid and health grid need explicit mobile breakpoints below ~480px
