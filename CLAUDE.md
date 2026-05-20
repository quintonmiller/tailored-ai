# CLAUDE.md - Development Guide

Tight index for development. Subsystem deep-dives live in [`docs/`](./docs/).

## Build & Run

```bash
pnpm install              # install dependencies
pnpm run build            # compile all packages (core → server → cli → ui)
pnpm run typecheck        # type-check all packages
pnpm run test             # run unit tests (vitest)
pnpm run test:watch       # run core tests in watch mode
pnpm run dev              # run CLI via tsx (builds core+server first)
pnpm run dev -- -m "msg"  # non-interactive single message
pnpm run dev -- -a NAME -m "msg"  # use a named agent
pnpm run dev -- --list-agents     # list configured agents
pnpm run dev -- --list-sessions   # list recent sessions
pnpm run dev -- project init      # register cwd as a project
pnpm run dev -- project list      # show registered projects
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
- **No conditional response tokens**: Never use patterns like "reply NO_REPLY if..." — local models misinterpret these.
- **Simple agent loop**: No complex state machines. Loop: chat → tool calls → chat → stop.
- **Hot-reloadable runtime**: Config, tools, and provider are mutable at runtime. The agent loop re-resolves tools each iteration so changes take effect immediately without restart.

## Conventions

- No default parameter values that duplicate config defaults (config.ts `DEFAULT_CONFIG` is the single source of truth)
- All configurable values go in `config.yaml` / `AgentConfig`
- Tool descriptions: 1-2 sentences max (for local model compatibility)
- Prefer `node:` prefixed imports for Node.js built-ins

## Subsystem index

Deep notes on each subsystem live under [`docs/`](./docs/):

| Topic | Doc |
|---|---|
| AgentRuntime, factories, adding tools/channels/providers, admin tool | [docs/architecture.md](./docs/architecture.md) |
| Agent loop: history compaction, validation, retry, timing, providers | [docs/agent-loop.md](./docs/agent-loop.md) |
| Named agents, delegation, hooks, cron jobs, prompt expansion | [docs/agents-and-hooks.md](./docs/agents-and-hooks.md) |
| Background tasks, project tasks, pluggable backends, autopilot | [docs/tasks-and-autopilot.md](./docs/tasks-and-autopilot.md) |
| Tiered memory (recall, embeddings, promotion, sweep, HTTP/UI) | [docs/memory.md](./docs/memory.md) + design [docs/memory-tiers.md](./docs/memory-tiers.md) |
| Sandboxes (host/docker/podman) and `git worktree` helpers | [docs/sandboxes-and-worktrees.md](./docs/sandboxes-and-worktrees.md) |
| Per-project mode: `.tai.yaml`, overlays, project_id threading | [docs/projects.md](./docs/projects.md) |
| Chat output tags (`<task/>`, `<proposal>`, `<ask>`, etc.) | [docs/chat-tags.md](./docs/chat-tags.md) |
| Workflow engine | [docs/workflows.md](./docs/workflows.md) |
| Always-on agents, use cases, S9 audit, autonomous backlog | [docs/](./docs/) |

When touching a subsystem, update its doc — keep this index file tight.
