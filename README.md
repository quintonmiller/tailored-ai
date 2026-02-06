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

agent:
  defaultProvider: "ollama"
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
├── agent/
│   ├── loop.ts            # Agent loop: chat → tool calls → chat → ...
│   └── session.ts         # Session creation and resumption
├── providers/
│   ├── interface.ts       # AIProvider, Message, ChatParams types
│   └── ollama.ts          # Ollama /api/chat implementation
├── channels/
│   ├── interface.ts       # Channel interface
│   └── discord.ts         # Discord bot (DMs + @mentions)
├── tools/
│   ├── interface.ts       # Tool interface
│   ├── exec.ts            # Run shell commands
│   ├── read.ts            # Read files
│   └── write.ts           # Write files
├── cron/                  # Cron scheduler (future)
└── db/
    ├── schema.ts          # SQLite schema
    └── queries.ts         # Database operations
```

### Agent Loop

The core loop is simple by design (local models struggle with complex flows):

1. Append user message to session history
2. Send system prompt + history + tool schemas to the LLM
3. If the LLM returns tool calls, execute them and append results
4. Repeat until the LLM returns a final text response (or max rounds hit)

### Providers

Providers implement `AIProvider` and handle LLM API communication. Currently implemented:

- **Ollama** - Native `/api/chat` with tool calling support

Planned: OpenAI, Anthropic, OpenRouter

### Tools

Tools implement `Tool` with a `name`, `description`, JSON schema `parameters`, and `execute` method. Current tools:

| Tool | Description |
|------|-------------|
| `exec` | Run shell commands (with optional command allowlist) |
| `read` | Read file contents (with optional path restrictions) |
| `write` | Write/create files (with optional path restrictions) |

Planned: `web_search`, `web_fetch`

### Channels

Channels connect the agent to messaging platforms. Currently implemented:

- **Discord** - Responds to DMs and @mentions. Per-user sessions with history persistence. Configurable guild allowlist.

Planned: Slack, Telegram

## Prerequisites

- Node.js 20+
- Ollama running locally (or configure a different provider)
- Discord bot token (for `--serve` mode)

### Hardware (for local LLMs)

Tested with:
- RTX 5090 (32GB VRAM)
- Models: devstral-small-2 (~15GB), qwen3-coder:30b (~18GB)

## Roadmap

See [SPEC.md](./SPEC.md) for the full specification. Phase summary:

1. **Core Agent** - Ollama provider, tools, agent loop, CLI (done)
2. **Discord + Persistence** - Bot integration, session management (done)
3. **Sub-agents + Cron** - Parallel tasks, scheduled jobs
4. **Web UI** - Dashboard, REST API, OpenAI provider
5. **Extensibility** - Skill definitions, more channels
