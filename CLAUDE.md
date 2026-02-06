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

## Adding a New Tool

1. Create `src/tools/<name>.ts` implementing the `Tool` interface from `src/tools/interface.ts`
2. Add config type in `src/config.ts` under `AgentConfig.tools`
3. Wire it up in `src/cli.ts` in the `createTools()` function
4. Export from `src/index.ts`

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
