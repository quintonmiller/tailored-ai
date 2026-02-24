# CLAUDE.md - Development Guide

## Build & Run

```bash
pnpm install              # install dependencies
pnpm run build            # compile all packages (core → server → cli → ui)
pnpm run typecheck        # type-check all packages
pnpm run test             # run unit tests (vitest)
pnpm run test:watch       # run core tests in watch mode
pnpm run dev              # run CLI via tsx (builds core+server first)
pnpm run dev -- -m "msg"  # non-interactive single message
pnpm run serve            # run Discord bot service (needs DISCORD_BOT_TOKEN env)
pnpm run dev:ui           # Vite dev server with proxy
pnpm run start            # run compiled CLI
```

## Project Structure

pnpm monorepo with 4 packages:

| Package | Path | Purpose | Depends on |
|---------|------|---------|------------|
| `@agent/core` | `packages/core/` | Agent library: runtime, config, tools, providers, channels, db, cron, hooks, factories | — |
| `@agent/server` | `packages/server/` | HTTP API server (Hono routes, SSE, webhooks, static UI serving) | `@agent/core` |
| `@agent/cli` | `packages/cli/` | CLI entry point (arg parsing, REPL, service orchestration) | `@agent/core`, `@agent/server` |
| `@agent/ui` | `packages/ui/` | React frontend (Vite SPA) | — (HTTP API only) |

- ESM project (`"type": "module"` in all packages)
- Internal imports within a package use relative `.js` extensions (Node16 module resolution)
- Cross-package imports use the `@agent/*` workspace specifier
- SQLite via `better-sqlite3` (synchronous API)
- Config via `config.yaml` with `${ENV_VAR}` interpolation

## Key Design Decisions

- **Short system prompts**: Local models degrade with prompts >500 tokens. Keep them concise.
- **Few tools per request**: Max ~5 tools. Local models struggle to pick from large sets.
- **Low temperature**: Default 0.3 for deterministic tool selection.
- **No conditional response tokens**: Never use patterns like "reply NO_REPLY if..." - local models misinterpret these.
- **Simple agent loop**: No complex state machines. Loop: chat → tool calls → chat → stop.
- **Hot-reloadable runtime**: Config, tools, and provider are mutable at runtime. The agent loop re-resolves tools each iteration so changes take effect immediately without restart.

## AgentRuntime

`packages/core/src/runtime.ts` holds all mutable state (config, tools, provider) and provides getters that return the current values. Key behaviors:

- **`reload()`** — re-reads `config.yaml`, rebuilds tools and provider. All-or-nothing: keeps previous state on failure.
- **`startWatching()`** — uses `fs.watch` with 500ms debounce to auto-reload on config file changes.
- **`resolveHooks({ agentName?, overrideHooks? })`** — resolves merged hooks for an agent + optional overrides (e.g. cron job hooks).
- **`generation`** — monotonic counter that increments on each successful reload.
- Factory functions (`createTools`, `createProvider`) are defined in `packages/core/src/factories.ts` and injected into the runtime.
- The agent loop accepts optional `getTools`/`getProvider` closures to re-resolve per iteration. Tool-change detection injects a transient system message when the tool set changes mid-loop.
- All subsystems (server, discord, cron, delegate) hold a runtime reference and read state at request time.

## Factories (`packages/core/src/factories.ts`)

Composition layer that constructs tools, providers, and meta tools:

- **`createTools(config, contextDir, configPath?, opts?)`** — builds the tool array from config. Accepts optional `CreateToolsOptions` with `db` (for project tasks), `getDiscord`/`getOwnerId` closures (for `AskUserTool`).
- **`createProvider(config)`** — creates the AI provider + model from config.
- **`createMetaTools(runtime, contextDir, kbDir)`** — creates delegate, task_status, and admin tools.

## Adding a New Tool

**Code-level tool** (requires TypeScript):
1. Create `packages/core/src/tools/<name>.ts` implementing the `Tool` interface from `packages/core/src/tools/interface.ts`
2. Add config type in `packages/core/src/config.ts` under `AgentConfig.tools`
3. Wire it up in `packages/core/src/factories.ts` in the `createTools()` function
4. Export from `packages/core/src/index.ts`

**Custom tool** (config-only, no code):
Add an entry under `custom_tools` in `config.yaml`. Custom tools are shell command templates with `{{param}}` interpolation. They are rebuilt on every runtime reload, so adding one via the admin tool or editing `config.yaml` makes it available immediately.

```yaml
custom_tools:
  hello:
    description: "Say hello to someone"
    parameters:
      name: { type: "string", description: "Name to greet" }
    command: "echo Hello {{name}}"
    timeout_ms: 5000  # optional, default 30s
```

## Adding a New Channel

1. Create `packages/core/src/channels/<name>.ts` implementing `Channel` from `packages/core/src/channels/interface.ts`
2. Add config type in `packages/core/src/config.ts` under `AgentConfig.channels`
3. Wire it up in `packages/cli/src/index.ts` in the `runServe()` function
4. Export from `packages/core/src/index.ts`
5. Sessions are keyed per-user: use `findOrCreateSession(db, "channelname:userId", model, provider)`

## Adding a New Provider

1. Create `packages/core/src/providers/<name>.ts` implementing `AIProvider` from `packages/core/src/providers/interface.ts`
2. Add config type in `packages/core/src/config.ts` under `AgentConfig.providers`
3. Add provider creation in `packages/core/src/factories.ts` in the `createProvider()` function
4. Export from `packages/core/src/index.ts`

## History Compaction

The agent loop trims conversation history before each LLM call to stay within `config.agent.maxHistoryTokens` (default 2000). Token count is estimated at ~4 chars per token. Trimming drops the oldest messages first, but always skips past orphaned `tool` messages so tool-call/response groups stay intact. See `estimateTokens()` and `trimHistory()` in `packages/core/src/agent/loop.ts`.

Opt-in summarization: set `summarizeOnTrim: true` in an agent to replace silent trimming with a summary. When enabled, `trimHistoryWithSummary()` calls the LLM to summarize dropped messages into a `[Earlier conversation summary: ...]` system message. The summary is cached across loop rounds to avoid re-summarization. Falls back to silent trimming if summarization fails.

## Config Validation

`validateConfig()` in `packages/core/src/config.ts` checks for common configuration errors at startup:

- Agent tool references pointing to non-existent tools
- Hook tool references pointing to non-existent tools
- Cron job agent references pointing to non-existent agents
- Invalid default provider

Warnings are printed at CLI startup via `[config] Warning: ...`. Exported from `@agent/core`.

## Tool Parameter Validation

`validateToolArgs()` in `packages/core/src/agent/loop.ts` validates tool call arguments before execution:

- Checks required parameters are present
- Basic type matching (string, number, boolean, array)
- Returns clear errors with expected parameter list to the LLM

## Retry Utility

`packages/core/src/tools/retry.ts` provides `withRetry()` and `isTransientError()` for exponential backoff on external API calls:

- Default: 2 retries with 500ms → 1s → 2s delays
- `isTransientError()` detects fetch failures, connection errors, 429/502/503 status codes
- Applied to `web_fetch` and `web_search` tools
- Exported from `@agent/core`

## Tool Execution Timing

Tools taking >= 100ms have `[completed in Xms]` appended to their output, giving the LLM visibility into slow operations.

## Providers

Three providers are supported — set `agent.defaultProvider` in config:

- **Ollama** (`packages/core/src/providers/ollama.ts`) — local `/api/chat`, tool arguments are native objects
- **OpenAI** (`packages/core/src/providers/openai.ts`) — `POST /v1/chat/completions`, tool arguments are JSON strings (serialized on send, parsed on receive). Constructor accepts an optional `baseUrl` for OpenAI-compatible APIs.
- **Anthropic** (`packages/core/src/providers/anthropic.ts`) — Anthropic Messages API.

## Background Tasks

`packages/core/src/agent/tasks.ts` provides an in-memory task registry (intentionally ephemeral).

- `delegate` tool accepts `async: true` — fires the sub-agent as an unresolved promise, returns a task ID immediately
- `task_status` tool lets the agent list all tasks or check one by ID
- Task IDs are `task_<uuid-slice>` format
- Tasks track status (`running` / `completed` / `failed`), timing, and result/error

## Project Tasks

`packages/core/src/tools/tasks.ts` provides native SQLite-backed project task management, replacing the external Trello dependency.

- Two tools: `TasksTool` (CRUD: create/get/update/delete/comment) and `TaskQueryTool` (filter/search)
- Schema: `project_tasks` and `task_comments` tables in SQLite (see `packages/core/src/db/schema.ts`)
- Query functions in `packages/core/src/db/task-queries.ts` — supports filtering by status, author, tags, search text, and date
- Task IDs use `ptask_<8-char-uuid>` format
- Statuses: `backlog`, `in_progress`, `blocked`, `in_review`, `done`, `archived`
- Tags stored as JSON arrays, filtered via SQLite `json_each()`
- Tools accept common aliases for local model compatibility (`name`→`title`, `content`→`text`, `task_id`→`id`)
- REST API: 6 endpoints under `/api/project-tasks` (GET/POST collection, GET/PATCH/DELETE by ID, POST comments)
- Discord: `/tasks` slash command for quick list/create (handled directly, no agent loop)
- UI: Kanban board at `#/tasks` with drag-and-drop between status columns

## Admin Tool

`packages/core/src/tools/admin.ts` lets the agent read/modify its own configuration at runtime:

- Reads the raw YAML file for updates (not the merged config) so defaults don't pollute the user's file
- Writes trigger `runtime.reload()` for immediate effect
- Available in all tool closures alongside delegate and task_status (meta tools)

## Agents & Delegation

Agents are named configurations defined in `config.yaml` under `agents:`. They can override model, description, instructions, tools (allowlist), temperature, maxToolRounds, and hooks.

- `packages/core/src/agent/agents.ts` — `resolveAgent()` merges a named agent with agent defaults
- `packages/core/src/tools/delegate.ts` — `DelegateTool` lets the agent spawn a sub-agent with a specific agent config
- Sub-agents are depth-1 only (they don't get the delegate tool)
- Each delegation creates an ephemeral session keyed `delegate:<parentSessionId>:<uuid>`

**CLI usage:**
```bash
pnpm run dev -- -a researcher -m "Find AI news"   # use a named agent
pnpm run dev -- --list-agents                      # show all agents
pnpm run dev -- --list-sessions                    # show 20 most recent sessions
```

**Config example:**
```yaml
agents:
  researcher:
    description: "Research assistant for web search and summarization"
    instructions: "You are a research assistant."
    tools: ["web_search", "web_fetch", "memory"]
    temperature: 0.5
    maxToolRounds: 5
  coder:
    model: "qwen3-coder:30b"
    instructions: "You are a code assistant."
    tools: ["exec", "read", "write", "memory"]
    maxToolRounds: 15
    hooks:
      afterRun:
        - tool: memory
          args: { action: "append", file: "work-log.md", content: "{{response}}" }

cron:
  jobs:
    - name: "daily-research"
      schedule: "0 9 * * *"
      prompt: "Research today's AI news"
      agent: "researcher"
```

## Hooks

Hooks run tool calls before and/or after the agent loop. They are a first-class feature of agents and work across all entry points: CLI, Discord, HTTP API, webhooks, cron, and delegate.

### Configuration

Hooks can be defined at two levels:

1. **Agent-level** — in `agents.<name>.hooks` (runs everywhere the agent is used)
2. **Cron job-level** — in `cron.jobs[].hooks` (runs only for that cron job)

When both are present, agent hooks run first, then cron job hooks are appended.

```yaml
agents:
  researcher:
    instructions: "You are a research assistant."
    tools: ["web_search", "web_fetch", "memory"]
    hooks:
      beforeRun:
        - tool: memory
          args: { action: "read", file: "research-context.md" }
      afterRun:
        - tool: memory
          args: { action: "append", file: "research-log.md", content: "{{response}}" }

cron:
  jobs:
    - name: "daily-research"
      schedule: "0 9 * * *"
      prompt: "Research today's AI news"
      agent: "researcher"
      hooks:
        beforeRun:
          - tool: gmail
            args: { action: "check", query: "newer_than:1d" }
            skipIf: "no new messages"
```

### Hook shape (`AgentHook`)

```yaml
tool: "tool_name"            # required — name of any registered tool
args:                        # optional — arguments passed to the tool
  key: "value"               # string values support {{template}} interpolation
skipIf: "regex_pattern"      # optional — if output matches, skip the rest of the pipeline
```

- **`tool`** — the tool to execute (must exist in the full tool set, not agent-filtered)
- **`args`** — key/value pairs passed to the tool. String values support `{{var}}` template interpolation.
- **`skipIf`** — a regex tested against the tool output. If it matches, the remaining hooks and the agent loop are skipped (for `beforeRun`), or remaining `afterRun` hooks are skipped.

### Execution flow

1. **beforeRun hooks** execute sequentially before `runAgentLoop`
   - If any hook's `skipIf` matches, the agent loop is skipped entirely
   - In cron, non-empty hook outputs are prepended to the prompt as context
2. The agent loop runs normally
3. **afterRun hooks** execute sequentially after `runAgentLoop`
   - The `{{response}}` template variable contains the agent's response

### Template variables by entry point

| Entry Point | beforeRun vars | afterRun vars |
|---|---|---|
| Cron | `last_run`, `last_run_epoch`, `last_response`, `next_task` | same + `response` |
| CLI, Discord, HTTP, Webhooks, Delegate | `{}` (empty) | `{ response }` |

### Architecture (`packages/core/src/agent/hooks.ts`)

Shared module used by all entry points:

- **`normalizeHooks(hooks)`** — converts `undefined | AgentHook | AgentHook[]` to `AgentHook[]`
- **`mergeHooks(agentHooks?, overrideHooks?)`** — returns `ResolvedHooks` (agent hooks first, overrides appended)
- **`executeHooks(hooks, allTools, templateVars, sessionId, logPrefix?)`** — runs hooks sequentially, returns `{ outputs, skipped }`
- **`applyTemplates(text, vars)`** — replaces `{{key}}` placeholders
- **`hasHooks(hooks)`** / **`EMPTY_HOOKS`** — utilities

`AgentRuntime.resolveHooks({ agentName?, overrideHooks? })` is the main entry point for callers. It reads the agent's hooks from config and merges with any overrides. Each entry point (CLI, Discord, server, delegate, cron) wraps its `runAgentLoop` call with ~5-8 lines of beforeRun/afterRun hook execution.

## Adding a Cron Job

1. Add job config under `cron.jobs` in `config.yaml` (see `CronJobConfig` in `packages/core/src/config.ts`)
2. Set `cron.enabled: true`
3. Run with `--serve` — the scheduler starts automatically
4. Two modes: `wakeAgent: true` (default) runs agent loop; `wakeAgent: false` injects a note into the session
5. Delivery channels: `log` (default, stdout) or `discord` (requires `delivery.target` channel ID)
6. Job state is tracked in the `cron_jobs` DB table
7. Cron jobs can define their own `hooks` and also inherit hooks from their `agent` (agent hooks run first, job hooks appended). See the Hooks section above.

## Conventions

- No default parameter values that duplicate config defaults (config.ts `DEFAULT_CONFIG` is the single source of truth)
- All configurable values go in `config.yaml` / `AgentConfig`
- Tool descriptions: 1-2 sentences max (for local model compatibility)
- Prefer `node:` prefixed imports for Node.js built-ins
