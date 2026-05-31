# Tailored AI (`tai`)

Lightweight, modular AI agent framework optimized for local LLMs while supporting cloud providers. Designed from scratch to work well with smaller models (30B parameter quantized models on consumer GPUs) by keeping system prompts short, tool counts low, and context tight. Configuration, tools, and providers hot-reload at runtime — the agent can modify its own capabilities without restarting.

## Quick Start

```bash
pnpm install
pnpm run build
pnpm run start            # first run launches the setup wizard, then starts the server (HTTP API + UI + Discord + cron)
```

The setup wizard probes your provider (Ollama / OpenAI / Anthropic), seeds `~/.tailored-ai/config.yaml`, and writes a starter `.env`. After that:

```bash
# Single message (non-interactive)
pnpm run dev -- -m "What is the current date?"

# Use a named agent
pnpm run dev -- -a researcher -m "Find AI news"

# JSON output for scripting
pnpm run dev -- -m "List files in /tmp" --json

# Resume a previous session
pnpm run dev -- -s <session-id>

# Inspect what's configured
pnpm run dev -- --list-agents
pnpm run dev -- --list-sessions

# Manage registered projects (see "Per-project mode" below)
pnpm run dev -- project init --name "My app"
pnpm run dev -- project list
```

For development:

```bash
pnpm run dev              # builds core+server then runs CLI via tsx
pnpm run dev:ui           # Vite dev server (proxies API to local tai instance)
```

## CLI options

| Flag | Short | Description |
|---|---|---|
| `--config <path>` | `-c` | Path to `config.yaml` (the directory becomes `TAI_HOME`) |
| `--message <text>` | `-m` | Send a single message and exit |
| `--session <id>` | `-s` | Resume an existing session |
| `--agent <name>` | `-a` | Use a named agent |
| `--json` | `-j` | Output as JSON (for scripting) |
| `--project <id>` |  | Scope to a specific registered project |
| `--global` |  | Force global mode even inside a registered project |
| `--port <n>` |  | Override server port |
| `--init` |  | Re-run the setup wizard |
| `--list-agents` |  | Show all configured agents and exit |
| `--list-sessions` |  | Show recent sessions (accepts `--project` / `--global`) |
| `--help` | `-h` | Show help |

Subcommands:

- `tai project {init,list,show,add,remove,help}` — manage the project registry (see Per-project mode)

The default mode (no flags) starts the server: HTTP API on `127.0.0.1:3000`, Web UI, Discord bot (if enabled), cron scheduler, and autopilot worker.

## Configuration

All settings live in `config.yaml` under `TAI_HOME` (default `~/.tailored-ai/`). Environment variables interpolate via `${VAR_NAME}`. See [`config.example.yaml`](./config.example.yaml) for a starter template.

```yaml
providers:
  ollama:
    baseUrl: "http://localhost:11434"
    defaultModel: "devstral-small-2:latest"
  # openai:    { apiKey: "${OPENAI_API_KEY}",    defaultModel: "gpt-4o-mini" }
  # anthropic: { apiKey: "${ANTHROPIC_API_KEY}", defaultModel: "claude-sonnet-4-5-20250929" }

agent:
  defaultProvider: "ollama"
  maxHistoryTokens: 20000
  temperature: 0.7
  maxToolRounds: 100
  sandbox: host             # "host" (default) | "docker" | "podman"

channels:
  discord:
    enabled: true
    token: "${DISCORD_BOT_TOKEN}"
    owner: "${DISCORD_OWNER_ID}"
    respondToDMs: true
    respondToMentions: true
    # projectMappings:                 # optional — bind channels/DMs to a project
    #   - { channel: "1234567890", project: proj_abc12345 }
    #   - { dm: true,              project: proj_xyz78901 }

tools:
  exec: { enabled: true, allowedCommands: ["git", "npm", "ls"] }
  read: { enabled: true }
  write: { enabled: true }
  web_fetch: { enabled: true }
  web_search: { enabled: true, provider: brave, apiKey: "${BRAVE_API_KEY}" }

agents:
  researcher:
    description: "Research assistant"
    instructions: "Search the web and summarize."
    tools: ["web_search", "web_fetch", "memory"]
    temperature: 0.5
    maxToolRounds: 8

cron:
  enabled: true
  jobs:
    - name: "daily-digest"
      schedule: "0 9 * * *"
      prompt: "Summarize my unread emails from the last 24 hours"
      agent: "researcher"
      delivery: { channel: "log" }

tasks:
  backend: native            # "native" (SQLite) | "github" | "beans" | "beads"

custom_tools:
  weather:
    description: "Get weather for a city"
    parameters: { city: { type: "string", description: "City name" } }
    command: "curl -s wttr.in/{{city}}?format=3"
```

If no config file is found, built-in defaults are used (Ollama on localhost:11434, basic tools enabled).

## Architecture

pnpm monorepo with 4 packages:

| Package | Purpose |
|---|---|
| `@tailored-ai/core` (`packages/core/`) | Runtime, config, tools, providers, channels, db, cron, hooks, factories, sandboxes, workflows, autopilot, projects |
| `@tailored-ai/server` (`packages/server/`) | HTTP API server (Hono routes, SSE, webhooks, static UI serving) |
| `@tailored-ai/cli` (`packages/cli/`) | CLI entry point and `tai project` subcommands |
| `@tailored-ai/ui` (`packages/ui/`) | React frontend (Vite SPA) |

For deeper architecture notes — agent loop, hot-reload, factories, hook semantics, conventions — see [CLAUDE.md](./CLAUDE.md) (index) and the deep-dives under [`docs/`](./docs/).

### Agent Loop

1. Append user message to session history
2. Re-resolve tools and provider (hot-reload safe)
3. Trim history to `maxHistoryTokens` (oldest first; tool-call groups stay intact; optional summarization via `summarizeOnTrim: true`)
4. Send system prompt + history + tool schemas to the LLM
5. Validate tool call args (required params + types) before execution
6. If tool calls present, execute in parallel via `Promise.all` and append results
7. Repeat until a final text response or max rounds hit

If the tool set changes mid-loop (e.g. a custom tool was added), a transient system message tells the LLM about the update.

### Providers

- **Ollama** — Native `/api/chat` with tool calling
- **OpenAI** — Chat Completions API; works with any OpenAI-compatible API (Groq, Together, etc.) via custom `baseUrl`
- **Anthropic** — Messages API with tool calling

### Tools

| Tool | Description |
|---|---|
| `exec` | Run shell commands (with optional command allowlist) |
| `read` / `write` | Read/write files (with optional path restrictions) |
| `web_fetch` | Fetch URLs and extract text |
| `web_search` | Brave web search |
| `memory` | Persistent notes in the context directory; `scope: "knowledge"` searches the KB |
| `browser` | Playwright-based browser automation |
| `tasks` / `task_query` | Project task CRUD + filtering (SQLite-backed kanban) |
| `documents` | Per-project markdown documents |
| `gmail` / `google_calendar` / `google_drive` | Google services via the gog CLI |
| `md_to_pdf` | Markdown → PDF |
| `ask_user` | Prompt the user (CLI or Discord) |
| `claude_code` | Delegate to the Claude Code CLI |
| `delegate` | Spawn a sub-agent (sync or `async: true`) |
| `task_status` | Inspect background tasks |
| `run_workflow` / `dispatch_workflow` | Run a defined workflow synchronously / async |
| `admin` | Read/update agent config and agents at runtime |
| *(custom)* | User-defined shell command tools (`custom_tools` in config) |

### Channels

- **Discord** — DMs + @mentions, per-user sessions, slash commands, optional channel→project mapping

### Agents (named configurations)

Agents live under `agents:` in `config.yaml`. Each can override model, instructions, tools (allowlist), temperature, `maxToolRounds`, `sandbox`, hooks, and a few smaller knobs. They're used by the `--agent` CLI flag, the `delegate` tool, cron jobs, autopilot, and Discord. Full schema and delegation semantics: [docs/agents-and-hooks.md](./docs/agents-and-hooks.md).

### Hooks

Tool calls run before/after the agent loop. Defined per-agent (runs everywhere the agent is used) or per-cron-job (runs only for that job). Agent hooks run first when both are present.

```yaml
agents:
  researcher:
    hooks:
      beforeRun:
        - tool: memory
          args: { action: "read", file: "context.md" }
      afterRun:
        - tool: memory
          args: { action: "append", file: "log.md", content: "{{response}}" }
```

Each hook supports `tool`, optional `args` (with `{{var}}` interpolation), and `skipIf` (regex on output — short-circuits the rest).

### Cron Jobs

Scheduled jobs run inside server mode:

- **wakeAgent: true** (default) — runs the full agent loop, delivers via `log` / `discord` / `discord-dm`
- **wakeAgent: false** — injects the prompt as a user message into the session without running the loop
- `project: <id>` — bind a job to a registered project (cwd, session scope, project_id stamp)
- Workflow trigger: `workflow: <name>` runs the named workflow instead of the agent loop

### Autopilot

A worker that wakes on an interval, claims one backlog task per tick, runs it via the configured agent, then marks it done / in_review / blocked based on the outcome. Supports per-tick token budgets, quiet hours, morning digests via Discord DM, and per-project task scoping.

### Workflows

Programmatic + declarative orchestration of multi-step jobs (`agent_run`, `tool_call`, `shell`, `condition`, `loop`, `parallel`). Run state in SQLite, SSE event stream. Triggered from CLI, cron, HTTP, webhooks, the `run_workflow` tool, or `AutopilotWorker`. Design doc: [`docs/workflows.md`](./docs/workflows.md).

### Sandboxes

Tool side-effects (`exec`, `read`, `write`) can route through a `Sandbox`:

- **`host`** (default) — runs on the host directly
- **`docker`** / **`podman`** — long-running container with cwd bind-mounted at `/work`. Per-agent override via `agents.<name>.sandbox`. See [docs/sandboxes-and-worktrees.md](./docs/sandboxes-and-worktrees.md).

### Task backends

`tasks.backend` selects the project-task store: `native` (SQLite, default), `github` (Issues), `beans` (CLI), or `beads` (CLI). The autopilot reads/writes through this single interface, so swapping backends doesn't change the rest of the system. See [docs/tasks-and-autopilot.md](./docs/tasks-and-autopilot.md) for status mapping and limitations.

### Per-project mode

`tai` runs in *global mode* by default — one home dir, one config, one DB. Per-project mode lets a single tai brain manage N registered repos:

```bash
cd ~/repos/my-app
tai project init --name "My app"      # writes .tai.yaml + DB row
tai project list                       # shows all registered (cwd's project marked *)
tai --list-sessions --project proj_…  # filter sessions by project
```

`.tai.yaml` can carry an optional `config:` overlay that merges over the global config (per-project agents, tools, task backend, etc.). Sessions, cron jobs, autopilot tasks, Discord channel mappings, and the UI's session list all scope by `project_id`.

### Worktrees

`createWorktree({ strategy })` runs an agent in an isolated git branch and optionally merges back. Strategies: `head` (no worktree), `branch` (fresh branch), `merge-to-head` (branch + auto-merge). Built for the workflow runner but usable directly. See [docs/sandboxes-and-worktrees.md](./docs/sandboxes-and-worktrees.md).

### Background tasks

The `delegate` tool with `async: true` fires sub-agents in the background. Tracked in-memory (intentionally ephemeral — they don't survive restarts). The `task_status` tool lists or inspects them by ID.

### Commands

Config-defined shell commands or prompts surfaced as slash commands in Discord and `/command` in the CLI:

```yaml
commands:
  review:
    description: "Review agent activity"
    command: "cat data/context/agents/autonomous/journal.md"
```

## Prerequisites

- Node.js 18+
- pnpm
- Ollama running locally **or** an OpenAI / Anthropic API key (or any OpenAI-compatible API)
- Discord bot token (optional, for Discord channel)

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
pnpm run test:watch       # core tests in watch mode
pnpm run lint             # check with biome
pnpm run lint:fix         # auto-fix lint issues
pnpm run dev              # CLI via tsx (builds core+server first)
pnpm run dev:ui           # web UI dev server
```

Per-package commands:

```bash
pnpm --filter @tailored-ai/core run build
pnpm --filter @tailored-ai/core run test
pnpm --filter @tailored-ai/server run typecheck
```

## Publishing

The public `@tailored-ai/*` packages are released via [Changesets](https://github.com/changesets/changesets). See [RELEASING.md](./RELEASING.md) for the per-release flow and the one-time npm + GitHub Actions setup.

## Docs

Subsystem deep-dives live under [`docs/`](./docs/). The CLAUDE.md index links each.
