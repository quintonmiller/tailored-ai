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
- [x] ~~Handle Discord reconnects / error recovery gracefully~~ — added `Events.Error`, `Events.ShardDisconnect`, `Events.ShardReconnecting`, `Events.ShardResume`, `Events.ShardError` handlers; processing set cleared on disconnect
- [ ] Guild channel allowlist testing (currently only DMs tested end-to-end)

## Phase 3: Sub-agents + Cron
- [x] Cron job scheduler (`packages/core/src/cron/scheduler.ts`, wake + note modes, delivery to log/discord)
- [x] Agent profiles (`packages/core/src/agent/profiles.ts`, config-driven model/tools/instructions per profile)
- [x] Delegate tool (`packages/core/src/tools/delegate.ts`, depth-1 sub-agent spawning with profiles)
- [x] Model routing via profiles (different models for different task types)
- [x] `--profile` CLI flag for using named profiles
- [x] Cron jobs support `profile` field for per-job configuration
- [x] Background task management (`packages/core/src/agent/tasks.ts`, async delegate + `task_status` tool)

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
- [x] Context/memory system (`packages/core/src/context.ts`, loads `.md` files into system prompt)
- [x] Dashboard upgrade — 6-section layout (status, profiles, cron, tasks, context, sessions), tools page, 5 new API endpoints
- [x] OpenAI provider (`packages/core/src/providers/openai.ts`, raw fetch, configurable base URL)

## Phase 5: Extensibility
- [x] Hot-reloadable runtime (`packages/core/src/runtime.ts`, `fs.watch` with 500ms debounce, dynamic tool/provider per loop iteration)
- [x] Admin tool (`packages/core/src/tools/admin.ts`, runtime config reads/writes, profile management)
- [x] Custom tools (`packages/core/src/tools/custom.ts`, config-defined shell command templates with `{{param}}` interpolation)
- [ ] Additional channels (Slack, Telegram)
- [x] ~~Webhook receiver~~ — `POST /api/webhooks/:route` with configurable routes, token auth (`webhooks.secret`), payload templating (`{{field.path}}`), agent or log action modes
- [x] ~~Chat UI in dashboard~~ — `Chat.tsx` with SSE streaming, message history, tool call/result visualization, auto-scroll, session management

## Phase 5.5: Monorepo
- [x] Convert to pnpm monorepo with 4 packages: `@agent/core`, `@agent/server`, `@agent/cli`, `@agent/ui`
- [x] Extract `createTools`, `createProvider`, `createMetaTools` to `packages/core/src/factories.ts`
- [x] Server imports from `@agent/core`, accepts `uiDistPath` option
- [x] CLI imports from `@agent/core` + `@agent/server`
- [x] TypeScript project references with `tsc -b` builds

## Security
- [x] ~~Exec tool allowlist is bypassable~~ — now rejects shell metacharacters (`; | & $ ...`) when an allowlist is active
- [x] ~~HTTP API has no authentication~~ — added `server.apiKey` config option; mutating endpoints require `Bearer` token when set
- [x] ~~Admin tool has no path restrictions~~ — added allowlist of writable path prefixes (profiles, custom_tools, cron, agent tuning); everything else is blocked
- [x] ~~Custom tool interpolation order~~ — switched from sequential `replaceAll` to single-pass regex replace using a pre-built map

## Bugs / Tech Debt
- [x] ~~Database path resolves relative to CWD~~ — now resolves relative to config file directory, so DB location is stable regardless of invocation directory
- [x] ~~No history compaction yet~~ — `trimHistory()` in `loop.ts` now enforces `maxHistoryTokens`
- [ ] Both OpenClaw and autonomous-agent share the same Discord bot token - will need separate bot apps for production use
- [x] ~~No unit tests yet~~ — vitest with 55 tests across config, loop, profiles, openai, and anthropic
- [x] ~~`trimHistory` is O(n²)~~ — replaced `shift()` loop with index pointer + final `slice()`
- [x] ~~System prompt not counted in token budget~~ — system prompt tokens are now subtracted from the history budget before trimming
- [x] ~~Concurrent config writes~~ — added `runtime.withConfigLock()` mutex; admin tool and server endpoints serialize config read-modify-write
- [x] ~~Browser tool leaks processes on reload~~ — added optional `destroy()` hook to `Tool` interface; runtime calls it on old tools during reload. `BrowserTool` closes chromium in `destroy()`
- [x] ~~Task registry grows unboundedly~~ — added eviction: finished tasks older than 1 hour are pruned, capped at 100 finished tasks
- [x] ~~`OpenAIProvider` doesn't handle empty `choices`~~ — added guard with descriptive error
- [x] ~~`loadConfig` path inconsistency~~ — now passes the resolved absolute `configPath` to `loadConfig()` instead of the raw CLI value
- [x] ~~Session model/provider never updates~~ — `findOrCreateSession` now updates model/provider to current defaults when resuming an existing session
- [x] ~~`saveMessage` does two DB writes~~ — `saveMessage` only does a single INSERT; session `updated_at` is handled by `trg_messages_update_session` trigger
- [x] ~~`startTime` is module-level in `server.ts`~~ — moved inside `createServer()` so it captures actual server start time

## Architecture
- [x] ~~Extract `AgentLoopOptions` factory~~ — added `runtime.buildLoopOptions({ session, profileName?, modelOverride?, extraTools? })` used by CLI, Discord, Server, and Cron
- [x] ~~Meta tools not in tool registry~~ — `runtime.setMetaTools()` registers delegate/task_status/admin; `buildLoopOptions()` auto-includes them so all modes (CLI, Discord, server, cron) get them
- [x] ~~`createProvider` ignores OpenAI `baseUrl`~~ — now passes `config.providers.openai.baseUrl` to the constructor
- [x] ~~Add `baseUrl` to OpenAI config type~~ — added optional `baseUrl` field to `AgentConfig.providers.openai`
- [ ] No streaming in agent loop — `chatStream` exists in the provider interface but is never used. SSE endpoint only streams tool events; LLM response arrives as one block
- [x] ~~No retry/backoff on provider calls~~ — added `withRetry()` wrapper (1 retry after 1s delay) around `provider.chat()` in the agent loop
- [x] ~~No graceful shutdown for in-flight loops~~ — `runtime.initiateShutdown()` signals via `AbortController`; agent loop checks `signal.aborted` before each round; shutdown handler waits 500ms for in-flight loops
- [x] ~~File watcher fragility~~ — added `fs.watch` error handler with automatic fallback to stat-based polling (2s interval)
- [x] ~~Discord reconnection handling~~ — (see Phase 2 fix above)
- [x] ~~Monorepo conversion~~ — pnpm workspace with `@agent/core`, `@agent/server`, `@agent/cli`, `@agent/ui` packages; factory functions extracted to core

## DX
- [x] ~~No test framework~~ — vitest configured with `pnpm run test` and `pnpm run test:watch` scripts; 5 test files, 55 tests covering core logic
- [x] ~~No linting/formatting~~ — Biome configured with lint + format rules, pnpm scripts added (`lint`, `lint:fix`, `format`)
- [x] ~~No `engines` field in package.json~~ — added `"engines": { "node": ">=18.0.0" }`

## Dashboard Improvements
- [x] ~~Active nav highlighting~~ — already implemented (`.active` class on nav links)
- [x] ~~Dashboard section spacing~~ — empty states already have `margin-bottom: 32px`
- [x] ~~Context file lazy loading~~ — `/api/context` now returns file names only; new `/api/context/file?name=&scope=` endpoint loads content on demand; `ContextFiles` component fetches on expand
- [x] ~~Cron config+DB merge~~ — `/api/cron` now merges config-defined jobs with DB rows; shows profile, delivery, and `in_db` flag
- [x] ~~Tool search/filter~~ — added search input on Tools page that filters by name and description
- [x] ~~Relative time auto-refresh~~ — `useRelativeTime()` hook forces re-render every 30s in SessionList, CronJobList, and TaskList
- [x] ~~Loading skeletons~~ — dashboard shows pulsing skeleton placeholders while data loads (health cards, profiles, cron, tasks, context, sessions)
- [x] ~~Responsive breakpoints~~ — added `@media (max-width: 480px)` breakpoints for health grid (2-col), profile grid (1-col), header (stacked), tools header, config header, chat

## Phase 6: Agent Intelligence
- [ ] Conversation summarization — when history is trimmed, summarize dropped messages into a condensed context block instead of discarding them
- [ ] Tool result caching — cache identical tool calls within a session (keyed by tool name + args hash) to avoid redundant work
- [ ] Multi-step planning — a `plan` tool that lets the agent outline steps before executing, with checkpoints for complex tasks
- [ ] Self-reflection — after completing a task, the agent evaluates its own output quality and optionally retries

## Phase 7: New Tools & Integrations
- [ ] GitHub tool — issues, PRs, repo search via `gh` CLI (similar pattern to gmail/gog tools)
- [ ] Notion tool — read/write pages and databases via Notion API
- [ ] Image generation — wrap a local Stable Diffusion or DALL-E API call
- [ ] Code execution sandbox — run Python/JS in an isolated container instead of raw `exec`
- [ ] RSS/feed monitor — subscribe to feeds, surface new items in autonomous sessions
- [ ] Voice channel — Whisper for input, TTS for output as a new channel type

## Phase 8: Infrastructure & Reliability
- [ ] Structured logging — replace `console.log` with leveled logging (debug/info/warn/error) with optional file output
- [ ] Metrics dashboard — track tool call counts, latencies, token usage, error rates over time; store in SQLite, surface in UI
- [ ] Cost tracking — for OpenAI/paid providers, track token usage and estimated cost per session
- [ ] Provider fallback chain — if the primary provider fails, automatically try a backup (e.g., Ollama → OpenAI)
- [ ] Rate limiting — per-user or per-channel rate limits to prevent runaway usage

## Phase 9: Autonomy & Memory
- [ ] Long-term memory with embeddings — vector store (e.g., SQLite + embeddings) for semantic memory recall instead of flat `.md` files
- [ ] Goal tracking — structured goal/subgoal system that persists across autonomous sessions with progress metrics
- [ ] Inter-session handoff — when an autonomous session hits its round limit, write a handoff note the next session picks up seamlessly
- [ ] Skill learning — when the agent solves a novel problem, auto-create a custom tool so it can reuse the approach

## Phase 10: UI & UX
- [ ] Token usage visualization — show token counts per message and cumulative per session in the chat UI
- [ ] Tool call timeline — visual timeline of tool executions with durations and dependencies
- [ ] Multi-session view — side-by-side sessions in the dashboard
- [ ] Mobile-friendly chat — dedicated mobile chat experience beyond basic responsive breakpoints
- [ ] Config editor with validation — schema-aware validation and field-level editing instead of raw YAML editor

## Phase 11: Channels
- [ ] Slack integration — similar architecture to Discord channel
- [ ] Telegram bot — lightweight bot API, good for mobile interaction
- [ ] Matrix channel — open-source chat protocol, good fit for self-hosted agents
- [ ] Email inbound — IMAP polling or webhook to let the agent respond to emails directly
