# Tailored AI (`tai`)

Tailored AI is a modular framework for running personal agents. It gives you a working local-first agent system in minutes, then lets you replace the pieces as your workflow gets more specific: models, tools, agents, channels, UI surfaces, task backends, workflows, repo integrations, sandboxes, and plugins.

TAI is still moving quickly, but it works end-to-end today: install the `tai` CLI, run the setup wizard, start the server, chat through the bundled UI or CLI, add agents/tools/plugins, and connect channels such as Discord or Slack.

Design priorities:

- **Modular by default** - most runtime surfaces have interfaces, registries, and config selection.
- **Personal-agent first** - projects, memory, tasks, cron, workflows, and autopilot are built around agents that can keep working with context.
- **Small-model friendly** - short prompts, low tool counts, tight context, and deterministic defaults keep local LLMs viable.
- **Useful immediately** - sensible defaults, an interactive config editor, and first-party packages make the first run boring in the good way.
- **Plugin-friendly** - external packages can register tools, channels, providers, UI/resource surfaces, and other extension points.

## Quick Start

### Install from npm

Prerequisites:

- Node.js 20+
- npm
- One model provider: Ollama locally, or an OpenAI / Anthropic / OpenAI-compatible API key

```bash
npm install -g @tailored-ai/cli
tai init                 # create ~/.tailored-ai/config.yaml
tai                      # start HTTP API + bundled UI + channels + cron/autopilot
```

By default the server binds to `127.0.0.1:3000`. The setup wizard probes available providers, writes a starter `.env`, and creates `config.yaml` under `~/.tailored-ai/`.

After setup:

```bash
tai -m "What is the current date?"          # one-shot message
tai -a researcher -m "Find AI news"         # use a named agent
tai --list-agents                           # inspect configured agents
tai --list-sessions                         # inspect recent sessions
tai project init --name "My app"            # register the current repo
tai project list
tai edit                                    # open the TUI settings editor
```

### Develop from source

```bash
pnpm install
pnpm run build
pnpm run start            # run compiled CLI from the workspace
pnpm run dev              # builds core+server then runs CLI via tsx
pnpm run dev:ui           # Vite dev server (proxies API to local tai instance)
pnpm run dev:site         # docs/marketing site
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
| `--init` |  | Re-run the setup wizard (deprecated alias for `tai init`) |
| `--list-agents` |  | Show all configured agents and exit |
| `--list-sessions` |  | Show recent sessions (accepts `--project` / `--global`) |
| `--help` | `-h` | Show help |

Subcommands:

- `tai init` / `tai edit` — create or edit `config.yaml` in the TUI
- `tai project {init,list,show,add,remove,help}` — manage the project registry (see Per-project mode)
- `tai plugin {install,remove,list,upgrade,help}` — install external plugins into the TAI plugin home
- `tai resources ...` — inspect resource bundles exposed by core or plugins

The default mode (no flags) starts the server: HTTP API on `127.0.0.1:3000`, Web UI, Discord bot (if enabled), cron scheduler, and autopilot worker.

## Configuration

All settings live in `config.yaml` under `TAI_HOME` (default `~/.tailored-ai/`). Environment variables interpolate via `${VAR_NAME}`. See [`config.example.yaml`](./config.example.yaml) for a starter template.

```yaml
providers:
  openai_compatible:
    baseUrl: "http://localhost:11434/v1"
    defaultModel: "devstral-small-2:latest"
  # openai:    { apiKey: "${OPENAI_API_KEY}",    defaultModel: "gpt-4o" }
  # anthropic: { apiKey: "${ANTHROPIC_API_KEY}", defaultModel: "claude-sonnet-4-6" }

agent:
  defaultProvider: "openai_compatible"
  maxHistoryTokens: 20000
  temperature: 0.3
  maxToolRounds: 10
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

plugins: []                 # e.g. ["@tailored-ai/google-tools", "@tailored-ai/channel-slack"]

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

If no config file is found, built-in defaults are used (OpenAI-compatible provider pointed at Ollama's `http://localhost:11434/v1`, basic tools enabled).

## Plugins

Plugins are normal npm packages (or any npm-compatible spec) that register new runtime pieces on import: tools, channels, providers, task backends, workflow step executors, UI providers, resources, skills, and event subscribers.

```bash
tai plugin install @tailored-ai/google-tools
tai plugin install @tailored-ai/channel-slack
tai plugin install git+https://github.com/you/tai-plugin-example.git
tai plugin install file:../my-local-plugin
tai plugin list
```

Plugins install into `<TAI_HOME>/plugins/` so they do not depend on the current project's `node_modules` or the global CLI install. Install and remove keep the `plugins:` list in `config.yaml` in sync automatically (pass `--no-save` to manage it yourself), so after an install the plugin is enabled on next startup:

```yaml
plugins:
  - "@tailored-ai/google-tools"
  - "@tailored-ai/channel-slack"

channels:
  slack:
    enabled: true
    botToken: ${SLACK_BOT_TOKEN}
    signingSecret: ${SLACK_SIGNING_SECRET}
```

The TUI settings editor (`tai edit`) can also add and remove plugin entries.

### Default plugins

The out-of-the-box workflow ships as four **default plugins** loaded through the same `plugins:` path as any third party — they are not privileged. They appear as `builtin:` entries (seeded automatically into a fresh config):

```yaml
plugins:
  - "builtin:discord-notifier"      # delivers agent.completed to your channel
  - "builtin:scope-creep-flagger"   # flags branches that touch other tasks
  - "builtin:stall-guard"           # retries or blocks stalled coder runs
  - "builtin:coder-project-guard"   # refuses unisolated coder/reviewer dispatch
```

- The `builtin:` prefix resolves to a module inside `@tailored-ai/core` (`@tailored-ai/core/plugins/<name>`) — no install needed. Any other entry resolves from the plugin home as usual.
- **Disable a default** by setting `enabled: false` on its entry. **Deleting** the entry is not durable: a load-time migration re-appends any missing `builtin:` default. Keeping the entry with `enabled: false` is the durable off switch (the loader skips it):

  ```yaml
  plugins:
    - module: "builtin:discord-notifier"
      enabled: false
  ```

- **Per-plugin config** goes in the entry's `config` bag and reaches the plugin as `ctx.config`. For example, override the stall retry cap:

  ```yaml
  plugins:
    - module: "builtin:stall-guard"
      config:
        maxStallRetries: 3
  ```

  (`discord-notifier` reads its delivery settings from `taskWatcher.delivery`, not a per-plugin knob.)

## Architecture

pnpm monorepo with first-party runtime packages, plugins, and docs:

| Package | Purpose |
|---|---|
| `@tailored-ai/cli` (`packages/cli/`) | Published `tai` command, setup/editor TUI, service orchestration, project/plugin commands |
| `@tailored-ai/core` (`packages/core/`) | Agent runtime, config, tools, providers, channels, resources, event bus, db, tasks, memory, cron, workflows, sandboxes, projects |
| `@tailored-ai/server` (`packages/server/`) | HTTP API server (Hono routes, SSE, webhooks, static UI serving) |
| `@tailored-ai/ui` (`packages/ui/`) | React frontend (Vite SPA) |
| `@tailored-ai/browser-mediator` (`packages/browser-mediator/`) | Framework-agnostic browser-control surface with OpenAI, Anthropic, and TAI adapters |
| `@tailored-ai/channel-slack` (`packages/channel-slack/`) | Slack channel plugin |
| `@tailored-ai/google-tools` (`packages/google-tools/`) | Gmail, Google Calendar, and Google Drive tool plugin |
| `@tailored-ai/trusted-actions` (`packages/trusted-actions/`) | Human-in-the-loop executor for approval-gated actions |
| `@tailored-ai/site` (`packages/site/`) | Next.js docs site |
| `@tailored-ai/integration-tests` (`packages/integration-tests/`) | End-to-end CLI/plugin/server smoke scenarios |

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

- **OpenAI-compatible** — Generic `/v1` chat completions for Ollama, vLLM, LM Studio, OpenRouter, Groq, Together, and similar gateways
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
| `gmail` / `google_calendar` / `google_drive` | Google services via the `@tailored-ai/google-tools` plugin |
| `md_to_pdf` | Markdown → PDF |
| `ask_user` | Prompt the user (CLI or Discord) |
| `claude_code` | Delegate to the Claude Code CLI |
| `delegate` | Spawn a sub-agent (sync or `async: true`) |
| `task_status` | Inspect background tasks |
| `run_workflow` / `dispatch_workflow` | Run a defined workflow synchronously / async |
| `admin` | Read/update agent config and agents at runtime |
| *(custom)* | User-defined shell command tools (`custom_tools` in config) |

### Channels

- **Discord** — Built-in DMs + @mentions, per-user sessions, slash commands, optional channel→project mapping
- **Slack** — First-party plugin via `@tailored-ai/channel-slack`
- **Custom channels** — Plugins can register Slack-like adapters for GitHub, Telegram, email, iMessage, or internal systems

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

- Node.js 20+
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
pnpm run build            # compile all workspace packages
pnpm run typecheck        # type-check all packages
pnpm run test             # run unit tests (vitest)
pnpm run test:watch       # core tests in watch mode
pnpm run lint             # check with biome
pnpm run lint:fix         # auto-fix lint issues
pnpm run dev              # CLI via tsx (builds core+server first)
pnpm run dev:site         # docs site
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
