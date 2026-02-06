# CLAUDE.md - Development Guide

## Build & Run

```bash
npm install              # install dependencies
npm run build            # compile TypeScript to dist/
npm run typecheck        # type-check without emitting
npm run dev              # run CLI via tsx (no build needed)
npm run dev -- -m "msg"  # non-interactive single message
npm run serve            # run Discord bot service (needs DISCORD_BOT_TOKEN env)
npm start                # run compiled CLI
```

## Project Structure

- `src/` - TypeScript source, compiles to `dist/`
- ESM project (`"type": "module"` in package.json)
- All imports use `.js` extensions (Node16 module resolution)
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

`src/runtime.ts` holds all mutable state (config, tools, provider) and provides getters that return the current values. Key behaviors:

- **`reload()`** — re-reads `config.yaml`, rebuilds tools and provider. All-or-nothing: keeps previous state on failure.
- **`startWatching()`** — uses `fs.watch` with 500ms debounce to auto-reload on config file changes.
- **`generation`** — monotonic counter that increments on each successful reload.
- Factory functions (`createTools`, `createProvider`) are injected from `cli.ts` so `runtime.ts` stays free of tool/provider imports.
- The agent loop accepts optional `getTools`/`getProvider` closures to re-resolve per iteration. Tool-change detection injects a transient system message when the tool set changes mid-loop.
- All subsystems (server, discord, cron, delegate) hold a runtime reference and read state at request time.

## Adding a New Tool

**Code-level tool** (requires TypeScript):
1. Create `src/tools/<name>.ts` implementing the `Tool` interface from `src/tools/interface.ts`
2. Add config type in `src/config.ts` under `AgentConfig.tools`
3. Wire it up in `src/cli.ts` in the `createTools()` function
4. Export from `src/index.ts`

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

1. Create `src/channels/<name>.ts` implementing `Channel` from `src/channels/interface.ts`
2. Add config type in `src/config.ts` under `AgentConfig.channels`
3. Wire it up in `src/cli.ts` in the `runServe()` function
4. Export from `src/index.ts`
5. Sessions are keyed per-user: use `findOrCreateSession(db, "channelname:userId", model, provider)`

## Adding a New Provider

1. Create `src/providers/<name>.ts` implementing `AIProvider` from `src/providers/interface.ts`
2. Add config type in `src/config.ts` under `AgentConfig.providers`
3. Add provider creation in `src/cli.ts` in the `createProvider()` function
4. Export from `src/index.ts`

## History Compaction

The agent loop trims conversation history before each LLM call to stay within `config.agent.maxHistoryTokens` (default 2000). Token count is estimated at ~4 chars per token. Trimming drops the oldest messages first, but always skips past orphaned `tool` messages so tool-call/response groups stay intact. See `estimateTokens()` and `trimHistory()` in `src/agent/loop.ts`.

## Providers

Two providers are supported — set `agent.defaultProvider` in config:

- **Ollama** (`src/providers/ollama.ts`) — local `/api/chat`, tool arguments are native objects
- **OpenAI** (`src/providers/openai.ts`) — `POST /v1/chat/completions`, tool arguments are JSON strings (serialized on send, parsed on receive). Constructor accepts an optional `baseUrl` for OpenAI-compatible APIs.

To add a new provider, see the "Adding a New Provider" section below.

## Background Tasks

`src/agent/tasks.ts` provides an in-memory task registry (intentionally ephemeral).

- `delegate` tool accepts `async: true` — fires the sub-agent as an unresolved promise, returns a task ID immediately
- `task_status` tool lets the agent list all tasks or check one by ID
- Task IDs are `task_<uuid-slice>` format
- Tasks track status (`running` / `completed` / `failed`), timing, and result/error

## Admin Tool

`src/tools/admin.ts` lets the agent read/modify its own configuration at runtime:

- Reads the raw YAML file for updates (not the merged config) so defaults don't pollute the user's file
- Writes trigger `runtime.reload()` for immediate effect
- Available in all tool closures alongside delegate and task_status (meta tools)

## Agent Profiles & Delegation

Profiles are named agent configurations defined in `config.yaml` under `profiles:`. They can override model, instructions, tools (allowlist), temperature, and maxToolRounds.

- `src/agent/profiles.ts` — `resolveProfile()` merges a named profile with agent defaults
- `src/tools/delegate.ts` — `DelegateTool` lets the agent spawn a sub-agent with a specific profile
- Sub-agents are depth-1 only (they don't get the delegate tool)
- Each delegation creates an ephemeral session keyed `delegate:<parentSessionId>:<uuid>`

**CLI usage:**
```bash
npm run dev -- -p researcher -m "Find AI news"   # use a named profile
```

**Config example:**
```yaml
profiles:
  researcher:
    instructions: "You are a research assistant."
    tools: ["web_search", "web_fetch", "memory"]
    temperature: 0.5
    maxToolRounds: 5
  coder:
    model: "qwen3-coder:30b"
    instructions: "You are a code assistant."
    tools: ["exec", "read", "write", "memory"]
    maxToolRounds: 15

cron:
  jobs:
    - name: "daily-research"
      schedule: "0 9 * * *"
      prompt: "Research today's AI news"
      profile: "researcher"
```

## Adding a Cron Job

1. Add job config under `cron.jobs` in `config.yaml` (see `CronJobConfig` in `src/config.ts`)
2. Set `cron.enabled: true`
3. Run with `--serve` — the scheduler starts automatically
4. Two modes: `wakeAgent: true` (default) runs agent loop; `wakeAgent: false` injects a note into the session
5. Delivery channels: `log` (default, stdout) or `discord` (requires `delivery.target` channel ID)
6. Job state is tracked in the `cron_jobs` DB table

## Conventions

- No default parameter values that duplicate config defaults (config.ts `DEFAULT_CONFIG` is the single source of truth)
- All configurable values go in `config.yaml` / `AgentConfig`
- Tool descriptions: 1-2 sentences max (for local model compatibility)
- Prefer `node:` prefixed imports for Node.js built-ins
