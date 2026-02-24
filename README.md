# autonomous-agent

Lightweight, modular AI agent framework optimized for local LLMs while supporting cloud providers. Designed from scratch to work well with smaller models (30B parameter quantized models on consumer GPUs) by keeping system prompts short, tool counts low, and context tight. Configuration, tools, and providers hot-reload at runtime — the agent can modify its own capabilities without restarting.

## Quick Start

```bash
pnpm install
cp config.example.yaml config.yaml   # edit with your settings
cp .env.example .env                  # add your API keys
pnpm run build

# Interactive REPL
pnpm run start

# Single message (non-interactive)
pnpm run start -- --message "What is the current date?"

# Use a named profile
pnpm run start -- --profile researcher --message "Find AI news"

# JSON output for scripting
pnpm run start -- --message "List files in /tmp" --json

# Run as a service (Discord bot + cron jobs)
pnpm run start -- --serve

# Resume a previous session
pnpm run start -- --session <session-id>
```

For development (no build step needed for CLI — core+server are built automatically):

```bash
pnpm run dev                              # interactive
pnpm run dev -- -m "Hello"                # single message
pnpm run dev -- -p researcher -m "Hello"  # with profile
pnpm run serve                            # Discord bot service
pnpm run dev:ui                           # web UI dev server (Vite + proxy)
```

## CLI Options

| Flag | Short | Description |
|------|-------|-------------|
| `--config <path>` | `-c` | Path to config.yaml (default: `./config.yaml`) |
| `--message <text>` | `-m` | Send a single message and exit |
| `--session <id>` | `-s` | Resume an existing session |
| `--profile <name>` | `-p` | Use a named agent profile |
| `--json` | `-j` | Output as JSON (for scripting) |
| `--serve` | | Run as a service (Discord bot, cron, HTTP API) |
| `--list-profiles` | | Show all configured profiles and exit |
| `--list-sessions` | | Show 20 most recent sessions and exit |
| `--help` | `-h` | Show help |

## Configuration

All settings live in `config.yaml` (see `config.example.yaml` for a starter template). Environment variables can be referenced with `${VAR_NAME}` syntax.

```yaml
server:
  port: 3000
  host: "127.0.0.1"

database:
  path: "./agent.db"

providers:
  ollama:
    baseUrl: "http://localhost:11434"
    defaultModel: "devstral-small-2:latest"
  # openai:
  #   apiKey: "${OPENAI_API_KEY}"
  #   defaultModel: "gpt-4o-mini"
  #   baseUrl: "https://api.openai.com/v1"  # optional, for compatible APIs
  # anthropic:
  #   apiKey: "${ANTHROPIC_API_KEY}"
  #   defaultModel: "claude-sonnet-4-5-20250929"

agent:
  defaultProvider: "ollama"   # or "openai" or "anthropic"
  extraInstructions: ""
  maxHistoryTokens: 2000
  temperature: 0.3
  maxToolRounds: 10

channels:
  discord:
    enabled: true
    token: "${DISCORD_BOT_TOKEN}"
    owner: "${DISCORD_OWNER_ID}"
    respondToDMs: true
    respondToMentions: true

tools:
  exec:
    enabled: true
    allowedCommands: ["git", "npm", "date", "ls"]
  read:
    enabled: true
  write:
    enabled: true
  web_fetch:
    enabled: true
  web_search:
    enabled: true
    provider: brave
    apiKey: "${BRAVE_API_KEY}"
  browser:
    enabled: true
    headless: true
  gmail:
    enabled: true
    account: "${GOG_ACCOUNT}"
  google_calendar:
    enabled: true
    account: "${GOG_ACCOUNT}"
  google_drive:
    enabled: true
    account: "${GOG_ACCOUNT}"
  md_to_pdf:
    enabled: true
  tasks:
    enabled: true
  ask_user:
    enabled: true

profiles:
  researcher:
    instructions: "Search the web and summarize findings."
    tools: ["web_search", "web_fetch", "memory"]
    temperature: 0.5
    maxToolRounds: 8

cron:
  enabled: true
  jobs:
    - name: "daily-email-summary"
      schedule: "0 9 * * *"
      prompt: "Summarize my unread emails from the last 24 hours"
      profile: "email-checker"
      delivery:
        channel: "log"

custom_tools:
  weather:
    description: "Get weather for a city"
    parameters:
      city: { type: "string", description: "City name" }
    command: "curl -s wttr.in/{{city}}?format=3"

commands:
  review:
    description: "Review agent activity"
    command: "cat data/context/profiles/autonomous/journal.md"
```

If no config file is found, built-in defaults are used (Ollama on localhost:11434, basic tools enabled).

## Architecture

pnpm monorepo with 4 packages:

| Package | Path | Purpose |
|---------|------|---------|
| `@agent/core` | `packages/core/` | Agent library: runtime, config, tools, providers, channels, db, cron, hooks, factories |
| `@agent/server` | `packages/server/` | HTTP API server (Hono routes, SSE, webhooks, static UI serving) |
| `@agent/cli` | `packages/cli/` | CLI entry point (arg parsing, REPL, service orchestration) |
| `@agent/ui` | `packages/ui/` | React frontend (Vite SPA) |

```
packages/
├── core/src/
│   ├── index.ts               # Barrel re-exports
│   ├── factories.ts           # createTools, createProvider, createMetaTools
│   ├── config.ts              # YAML config loader with env var interpolation
│   ├── runtime.ts             # AgentRuntime: hot-reloadable config, tools, provider
│   ├── context.ts             # Context/memory file loader
│   ├── shell.ts               # Shell command runner
│   ├── commands.ts            # Slash command parsing and execution
│   ├── agent/
│   │   ├── loop.ts            # Agent loop with history compaction + dynamic tools
│   │   ├── session.ts         # Session creation and resumption
│   │   ├── profiles.ts        # Named agent profile resolution
│   │   ├── prompt.ts          # Base system prompt
│   │   ├── hooks.ts           # beforeRun/afterRun hook execution engine
│   │   ├── compact.ts         # Session compaction (summarize + trim history)
│   │   └── tasks.ts           # In-memory background task tracking
│   ├── providers/
│   │   ├── interface.ts       # AIProvider, Message, ChatParams types
│   │   ├── ollama.ts          # Ollama /api/chat implementation
│   │   ├── openai.ts          # OpenAI chat completions implementation
│   │   └── anthropic.ts       # Anthropic Messages API implementation
│   ├── channels/
│   │   ├── interface.ts       # Channel interface
│   │   └── discord.ts         # Discord bot (DMs + @mentions + slash commands)
│   ├── tools/
│   │   ├── interface.ts       # Tool interface
│   │   ├── exec.ts            # Run shell commands
│   │   ├── read.ts            # Read files
│   │   ├── write.ts           # Write files
│   │   ├── web-fetch.ts       # Fetch URLs and strip HTML
│   │   ├── web-search.ts      # Brave web search
│   │   ├── memory.ts          # Persistent notes (with knowledge base search)
│   │   ├── browser.ts         # Playwright browser automation
│   │   ├── tasks.ts           # Native project task management (SQLite-backed)
│   │   ├── gmail.ts           # Gmail via gog CLI
│   │   ├── google-calendar.ts # Google Calendar via gog CLI
│   │   ├── google-drive.ts    # Google Drive upload/list via gog CLI
│   │   ├── md-to-pdf.ts       # Markdown to PDF conversion
│   │   ├── ask-user.ts        # Interactive user prompt (CLI/Discord)
│   │   ├── claude-code.ts     # Claude Code CLI delegation
│   │   ├── delegate.ts        # Sub-agent spawning (sync + async)
│   │   ├── task-status.ts     # Background task inspection
│   │   ├── admin.ts           # Runtime config and profile management
│   │   └── custom.ts          # Config-defined shell command tools
│   ├── cron/
│   │   └── scheduler.ts       # Config-driven cron job scheduler
│   ├── db/
│   │   ├── schema.ts          # SQLite schema
│   │   ├── queries.ts         # Database operations
│   │   └── task-queries.ts    # Project task CRUD and filtering
│   └── __tests__/             # Unit tests (vitest)
├── server/src/
│   └── index.ts               # Hono HTTP server (REST API + SSE chat)
├── cli/src/
│   └── index.ts               # CLI entry point (interactive + non-interactive)
└── ui/src/                    # React SPA (Vite)
```

### Agent Loop

The core loop is simple by design (local models struggle with complex flows):

1. Append user message to session history
2. Re-resolve tools and provider (via optional runtime getters — enables hot-reload)
3. Trim history to fit within `maxHistoryTokens` (drops oldest messages, keeps tool-call groups intact; optionally summarizes dropped messages with `summarizeOnTrim: true`)
4. Send system prompt + trimmed history + tool schemas to the LLM
5. Validate tool call arguments (required params, basic type checking) before execution
6. If the LLM returns tool calls, execute them in parallel via `Promise.all` and append results
7. Repeat until the LLM returns a final text response (or max rounds hit)

If the available tool set changes between iterations (e.g. a custom tool was added), the loop injects a transient system message notifying the LLM of the updated tools.

### Providers

Providers implement `AIProvider` and handle LLM API communication:

- **Ollama** — Native `/api/chat` with tool calling support
- **OpenAI** — Chat completions API with tool calling. Also works with any OpenAI-compatible API (Groq, Together, etc.) via custom `baseUrl`.
- **Anthropic** — Anthropic Messages API with tool calling support.

### Tools

Tools implement `Tool` with a `name`, `description`, JSON schema `parameters`, and `execute` method:

| Tool | Description |
|------|-------------|
| `exec` | Run shell commands (with optional command allowlist) |
| `read` | Read file contents (with optional path restrictions) |
| `write` | Write/create files (with optional path restrictions) |
| `web_fetch` | Fetch URLs and extract text content |
| `web_search` | Search the web (Brave API) |
| `memory` | Persistent notes in the context directory (supports knowledge base search) |
| `browser` | Playwright-based browser automation (navigate, click, type, screenshot) |
| `tasks` | Native project task management with kanban board (SQLite-backed) |
| `task_query` | Filter and search project tasks by status, author, tags, or text |
| `gmail` | Search, read, and send email via gog CLI |
| `google_calendar` | List, search, and create calendar events via gog CLI |
| `google_drive` | Upload files and list Google Drive contents via gog CLI |
| `md_to_pdf` | Convert markdown files to PDF |
| `ask_user` | Prompt the user for input (works in CLI and Discord) |
| `claude_code` | Delegate to the Claude Code CLI |
| `delegate` | Spawn a sub-agent with a named profile (supports `async: true` for background execution) |
| `task_status` | List or inspect background tasks started via async delegate |
| `admin` | Read/update agent configuration and manage profiles at runtime |
| *(custom)* | User-defined shell command tools declared in `config.yaml` under `custom_tools` |

### Channels

Channels connect the agent to messaging platforms:

- **Discord** — Responds to DMs and @mentions. Per-user sessions with history persistence. Slash commands for config-defined commands. Configurable guild allowlist.

### Profiles

Named agent configurations defined under `profiles:` in config. Each profile can override model, instructions, tools (allowlist), temperature, maxToolRounds, and hooks. Profiles are used by the `--profile` CLI flag, `delegate` tool, and cron jobs.

### Hooks

Hooks run tool calls before and/or after the agent loop. They can be defined at the profile level (runs everywhere the profile is used) or the cron job level (runs only for that job). When both are present, profile hooks run first.

```yaml
profiles:
  researcher:
    hooks:
      beforeRun:
        - tool: memory
          args: { action: "read", file: "context.md" }
      afterRun:
        - tool: memory
          args: { action: "append", file: "log.md", content: "{{response}}" }
```

Each hook specifies a `tool`, optional `args`, and optional `skipIf` (regex — if the tool output matches, remaining hooks and the agent loop are skipped).

### Commands

Config-defined shell commands or prompts exposed as slash commands in Discord and as `/command` in the CLI REPL:

```yaml
commands:
  review:
    description: "Review agent activity"
    command: "cat data/context/profiles/autonomous/journal.md"
```

### Cron Jobs

Scheduled jobs run inside `--serve` mode:

- **Wake agent** (`wakeAgent: true`, default) — Runs the full agent loop with the configured prompt, then delivers the response via the configured delivery channel (`log` or `discord`/`discord-dm`).
- **Add note** (`wakeAgent: false`) — Injects the prompt as a user message into the session without running the agent loop.

Jobs support profile assignment, hooks, prompt templating (`{{next_task}}`, `{{last_run}}`, etc.), and `newSession: true` to start fresh each run.

### Background Tasks

The delegate tool supports `async: true` to fire sub-agents in the background. Tasks are tracked in-memory (intentionally ephemeral — they don't survive restarts). The `task_status` tool lets the agent list all tasks or check on a specific one by ID.

## Prerequisites

- Node.js 18+
- pnpm
- Ollama running locally **or** an OpenAI API key **or** an Anthropic API key (or any OpenAI-compatible API)
- Discord bot token (for `--serve` mode)

### Hardware (for local LLMs)

Tested with:
- RTX 5090 (32GB VRAM)
- Models: devstral-small-2 (~15GB), qwen3-coder:30b (~18GB)

## Development

```bash
pnpm install              # install dependencies
pnpm run build            # compile all packages (core → server → cli → ui)
pnpm run typecheck        # type-check all packages
pnpm run test             # run unit tests (vitest)
pnpm run test:watch       # run core tests in watch mode
pnpm run lint             # check code with biome
pnpm run lint:fix         # auto-fix lint issues
pnpm run dev              # run CLI via tsx (builds core+server first)
pnpm run serve            # run Discord bot service (builds core+server first)
pnpm run dev:ui           # run web UI dev server
pnpm run build:ui         # build web UI for production
```

### Package-level commands

```bash
pnpm --filter @agent/core run build       # build core only
pnpm --filter @agent/core run test        # test core only
pnpm --filter @agent/server run typecheck # typecheck server only
```

## Roadmap

See [TASKS.md](./TASKS.md) for detailed task tracking. Current status:

1. **Core Agent** — Ollama provider, tools, agent loop, CLI *(done)*
2. **Discord + Persistence** — Bot integration, session management *(done)*
3. **Sub-agents + Cron** — Profiles, delegation, cron scheduler, background tasks *(done)*
4. **Web UI + Polish** — HTTP server, REST API, OpenAI provider, history compaction, dashboard UI *(done)*
5. **Extensibility** — Hot-reloadable runtime, admin tool, custom tools, hooks, commands, knowledge base *(done)*
6. **Monorepo** — pnpm workspace with `@agent/core`, `@agent/server`, `@agent/cli`, `@agent/ui` packages *(done)*
