# autonomous-agent

Lightweight, modular AI agent framework optimized for local LLMs while supporting cloud providers. Designed from scratch to work well with smaller models (30B parameter quantized models on consumer GPUs) by keeping system prompts short, tool counts low, and context tight.

## Quick Start

```bash
npm install
cp .env.example .env     # add your Discord bot token, API keys, etc.
npm run build

# Interactive REPL
npm start

# Single message (non-interactive)
npm start -- --message "What is the current date?"

# JSON output for scripting
npm start -- --message "List files in /tmp" --json

# Run as a service (Discord bot)
npm start -- --serve

# Resume a previous session
npm start -- --session <session-id>

# Custom config file
npm start -- --config /path/to/config.yaml
```

For development (no build step needed):

```bash
npm run dev                              # interactive
npm run dev -- --message "Hello"         # single message
npm run dev -- --message "Hello" --json  # JSON output
npm run serve                            # Discord bot service
```

## CLI Options

| Flag | Short | Description |
|------|-------|-------------|
| `--config <path>` | `-c` | Path to config.yaml (default: `./config.yaml`) |
| `--message <text>` | `-m` | Send a single message and exit |
| `--session <id>` | `-s` | Resume an existing session |
| `--json` | `-j` | Output as JSON (for scripting) |
| `--serve` | | Run as a service (Discord bot, etc.) |
| `--help` | `-h` | Show help |

## Configuration

All settings live in `config.yaml`. Environment variables can be referenced with `${VAR_NAME}` syntax.

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

agent:
  defaultProvider: "ollama"   # or "openai"
  systemPrompt: |
    You are a helpful assistant with access to tools.
    Use them when you need real information.
    After getting results, summarize for the user.
  maxHistoryTokens: 2000
  temperature: 0.3
  maxToolRounds: 10

channels:
  discord:
    enabled: true
    token: "${DISCORD_BOT_TOKEN}"
    respondToDMs: true
    respondToMentions: true
    # allowedGuilds:             # optional guild allowlist
    #   - "123456789"

cron:
  enabled: true
  jobs:
    - name: "daily-email-summary"
      schedule: "0 9 * * *"          # standard 5-field cron expression
      prompt: "Summarize my unread emails from the last 24 hours"
      # sessionKey: "cron:daily-email-summary"  # optional, defaults to "cron:<name>"
      # model: "devstral-small-2:latest"        # optional model override
      wakeAgent: true                 # true = run agent loop, false = just add note
      delivery:
        channel: "log"               # "log" | "discord"
        # target: "123456789"        # discord channel ID (required for discord)

tools:
  exec:
    enabled: true
    allowedCommands: ["git", "npm", "date", "ls"]  # optional allowlist
  read:
    enabled: true
    allowedPaths: ["/home/user/repos"]              # optional path restrictions
  write:
    enabled: true
    allowedPaths: ["/home/user/repos"]
```

If no config file is found, built-in defaults are used (Ollama on localhost:11434, all tools enabled with no restrictions).

## Architecture

```
src/
├── cli.ts                 # CLI entry point (interactive + non-interactive)
├── index.ts               # Library exports
├── config.ts              # YAML config loader with env var interpolation
├── context.ts             # Context/memory file loader
├── server.ts              # Hono HTTP server (REST API + SSE chat)
├── agent/
│   ├── loop.ts            # Agent loop with history compaction
│   ├── session.ts         # Session creation and resumption
│   ├── profiles.ts        # Named agent profile resolution
│   ├── prompt.ts          # Base system prompt
│   └── tasks.ts           # In-memory background task tracking
├── providers/
│   ├── interface.ts       # AIProvider, Message, ChatParams types
│   ├── ollama.ts          # Ollama /api/chat implementation
│   └── openai.ts          # OpenAI chat completions implementation
├── channels/
│   ├── interface.ts       # Channel interface
│   └── discord.ts         # Discord bot (DMs + @mentions)
├── tools/
│   ├── interface.ts       # Tool interface
│   ├── exec.ts            # Run shell commands
│   ├── read.ts            # Read files
│   ├── write.ts           # Write files
│   ├── web-fetch.ts       # Fetch URLs
│   ├── web-search.ts      # Brave web search
│   ├── memory.ts          # Persistent notes
│   ├── trello.ts          # Trello integration
│   ├── gmail.ts           # Gmail via gog CLI
│   ├── google-calendar.ts # Google Calendar via gog CLI
│   ├── claude-code.ts     # Claude Code CLI delegation
│   ├── delegate.ts        # Sub-agent spawning (sync + async)
│   └── task-status.ts     # Background task inspection
├── cron/
│   └── scheduler.ts       # Config-driven cron job scheduler
└── db/
    ├── schema.ts          # SQLite schema
    └── queries.ts         # Database operations
```

### Agent Loop

The core loop is simple by design (local models struggle with complex flows):

1. Append user message to session history
2. Trim history to fit within `maxHistoryTokens` (drops oldest messages, keeps tool-call groups intact)
3. Send system prompt + trimmed history + tool schemas to the LLM
4. If the LLM returns tool calls, execute them and append results
5. Repeat until the LLM returns a final text response (or max rounds hit)

### Providers

Providers implement `AIProvider` and handle LLM API communication. Currently implemented:

- **Ollama** - Native `/api/chat` with tool calling support
- **OpenAI** - Chat completions API with tool calling (also works with OpenAI-compatible APIs via custom `baseUrl`)

Planned: Anthropic, OpenRouter

### Tools

Tools implement `Tool` with a `name`, `description`, JSON schema `parameters`, and `execute` method. Current tools:

| Tool | Description |
|------|-------------|
| `exec` | Run shell commands (with optional command allowlist) |
| `read` | Read file contents (with optional path restrictions) |
| `write` | Write/create files (with optional path restrictions) |
| `web_fetch` | Fetch URLs and strip HTML |
| `web_search` | Search the web (Brave API) |
| `memory` | Persistent notes in the context directory |
| `trello` | Trello boards, lists, cards, and comments |
| `gmail` | Search, read, and send email via gog CLI |
| `google_calendar` | List, search, and create calendar events via gog CLI |
| `claude_code` | Delegate to the Claude Code CLI |
| `delegate` | Spawn a sub-agent with a named profile (supports `async: true` for background execution) |
| `task_status` | List or inspect background tasks started via async delegate |

### Channels

Channels connect the agent to messaging platforms. Currently implemented:

- **Discord** - Responds to DMs and @mentions. Per-user sessions with history persistence. Configurable guild allowlist.

Planned: Slack, Telegram

### Cron Jobs

Scheduled jobs run inside `--serve` mode and support two execution modes:

- **Wake agent** (`wakeAgent: true`, default) — Runs the full agent loop with the configured prompt, then delivers the response via the configured delivery channel (`log` or `discord`).
- **Add note** (`wakeAgent: false`) — Injects the prompt as a user message into the target session. The agent sees it as context on the next real interaction. No agent loop runs.

Job state (last run time) is tracked in the `cron_jobs` SQLite table. Scheduling uses the `croner` library with standard 5-field cron expressions.

## Prerequisites

- Node.js 20+
- Ollama running locally **or** an OpenAI API key (or any OpenAI-compatible API)
- Discord bot token (for `--serve` mode)

### Hardware (for local LLMs)

Tested with:
- RTX 5090 (32GB VRAM)
- Models: devstral-small-2 (~15GB), qwen3-coder:30b (~18GB)

### Background Tasks

The delegate tool supports `async: true` to fire sub-agents in the background. Tasks are tracked in-memory (intentionally ephemeral — they don't survive restarts). The `task_status` tool lets the agent list all tasks or check on a specific one by ID.

## Roadmap

See [SPEC.md](./SPEC.md) for the full specification. Phase summary:

1. **Core Agent** - Ollama provider, tools, agent loop, CLI (done)
2. **Discord + Persistence** - Bot integration, session management (done)
3. **Sub-agents + Cron** - Profiles, delegation, cron scheduler, background tasks (done)
4. **Web UI + Polish** - HTTP server, REST API, OpenAI provider, history compaction (done except dashboard UI)
5. **Extensibility** - Skill definitions, more channels
