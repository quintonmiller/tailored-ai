# CLAUDE.md - Development Guide

Tight index for development. Subsystem deep-dives live in [`docs/`](./docs/).

## Build & Run

```bash
pnpm install              # install dependencies
pnpm run build            # compile all workspace packages
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
pnpm run dev -- init      # run setup wizard
pnpm run dev -- edit      # open TUI config editor
pnpm run dev -- plugin list        # list installed plugins
pnpm run dev:ui           # Vite dev server with proxy
pnpm run dev:site         # Next.js docs site
pnpm run start            # run compiled CLI
pnpm run test:e2e         # integration smoke scenarios
```

## Project Structure

pnpm monorepo with first-party runtime packages, plugins, and docs:

| Package | Path | Purpose | Depends on |
|---------|------|---------|------------|
| `@tailored-ai/cli` | `packages/cli/` | Published `tai` command, setup/editor TUI, service orchestration, project/plugin commands | `@tailored-ai/core`, `@tailored-ai/server` |
| `@tailored-ai/core` | `packages/core/` | Agent library: runtime, config, tools, providers, channels, resources, event bus, db, tasks, memory, cron, hooks, factories | — |
| `@tailored-ai/server` | `packages/server/` | HTTP API server (Hono routes, SSE, webhooks, static UI serving) | `@tailored-ai/core` |
| `@tailored-ai/ui` | `packages/ui/` | React frontend (Vite SPA) | — (HTTP API only) |
| `@tailored-ai/browser-mediator` | `packages/browser-mediator/` | Framework-agnostic browser-control surface for LLM agents (OpenAI / Anthropic / TAI adapters) | — (zero TAI deps) |
| `@tailored-ai/channel-slack` | `packages/channel-slack/` | Slack channel plugin | `@tailored-ai/core` peer |
| `@tailored-ai/google-tools` | `packages/google-tools/` | Gmail, Google Calendar, Google Drive tool plugin | `@tailored-ai/core` peer |
| `@tailored-ai/provider-bedrock` | `packages/provider-bedrock/` | AWS Bedrock model provider plugin (Converse API) | `@tailored-ai/core` peer |
| `@tailored-ai/trusted-actions` | `packages/trusted-actions/` | HITL executor for approval-gated actions | `@tailored-ai/core` |
| `@tailored-ai/site` | `packages/site/` | Next.js docs site | private |
| `@tailored-ai/integration-tests` | `packages/integration-tests/` | End-to-end CLI/plugin/server smoke scenarios | private |

- ESM project (`"type": "module"` in all packages)
- Internal imports within a package use relative `.js` extensions (Node16 module resolution)
- Cross-package imports use the `@tailored-ai/*` workspace specifier
- SQLite via `better-sqlite3` (synchronous API)
- Config via `config.yaml` with `${ENV_VAR}` interpolation
- Published CLI package is `@tailored-ai/cli`; current public install path is `npm install -g @tailored-ai/cli`

## Current Direction

TAI is a modular framework for running personal agents. Keep docs and APIs oriented around replaceable components with intelligent defaults:

- Models/providers: OpenAI-compatible, OpenAI, Anthropic, OpenRouter/local gateways, and plugin providers.
- Messaging protocols/channels: Discord built in; Slack and future GitHub/Telegram/email/etc. as plugins.
- UI: bundled web UI by default, replaceable through the UI provider registry.
- Agents/skills/tools/resources/workflows/task backends/repo backends/sandboxes: interfaces + registries + config selection where practical.
- Plugins: install through `tai plugin` into `<TAI_HOME>/plugins/`; support npm specs, git URLs, tarballs, and local `file:` packages.
- Status: working end-to-end, still in active development. Prefer accurate "what works today" wording over polished but aspirational claims.

## Key Design Decisions

- **Short system prompts**: Local models degrade with prompts >500 tokens. Keep them concise.
- **Few tools per request**: Max ~5 tools. Local models struggle to pick from large sets.
- **Low temperature**: Default 0.3 for deterministic tool selection.
- **No conditional response tokens**: Never use patterns like "reply NO_REPLY if..." — local models misinterpret these.
- **Simple agent loop**: No complex state machines. Loop: chat → tool calls → chat → stop.
- **Hot-reloadable runtime**: Config, tools, and provider are mutable at runtime. The agent loop re-resolves tools each iteration so changes take effect immediately without restart.
- **Replaceable opinions**: Default behavior should be useful, but workflow opinions should move toward plugins/event subscribers instead of hardcoded core paths.

## Conventions

- No default parameter values that duplicate config defaults (config.ts `DEFAULT_CONFIG` is the single source of truth)
- All configurable values go in `config.yaml` / `AgentConfig`
- Tool descriptions: 1-2 sentences max (for local model compatibility)
- Prefer `node:` prefixed imports for Node.js built-ins
- **Releases stay on 0.x** until a deliberate V1. Mark **every changeset `patch`** — pre-1.0 a `minor`/`major` on `core` escalates the whole `fixed` group to `1.0.0`. npm publish is **manual + approval-gated** (`workflow_dispatch` + the `npm-publish` environment; never on push). CI runs `pnpm run guard:pre-v1`, which fails the build if any publishable version is `>= 1.0.0` or any changeset isn't `patch`. See [docs/publishing.md](./docs/publishing.md).

## Subsystem index

Deep notes on each subsystem live under [`docs/`](./docs/):

| Topic | Doc |
|---|---|
| AgentRuntime, factories, adding tools/channels/providers, admin tool | [docs/architecture.md](./docs/architecture.md) |
| Agent loop: history compaction, validation, retry, timing, providers | [docs/agent-loop.md](./docs/agent-loop.md) |
| Named agents, delegation, hooks, cron jobs, prompt expansion | [docs/agents-and-hooks.md](./docs/agents-and-hooks.md) |
| Background tasks, project tasks, pluggable backends, autopilot | [docs/tasks-and-autopilot.md](./docs/tasks-and-autopilot.md) |
| Repo backend (forge seam): push branch + manage proposals (PR/MR), default `gh` impl, events | [docs/repo-backend.md](./docs/repo-backend.md) |
| Tiered memory (recall, embeddings, promotion, sweep, HTTP/UI) | [docs/memory.md](./docs/memory.md) + design [docs/memory-tiers.md](./docs/memory-tiers.md) + storage-registry [docs/memory-storage-registry.md](./docs/memory-storage-registry.md) |
| Sandboxes (host/docker/podman) and `git worktree` helpers | [docs/sandboxes-and-worktrees.md](./docs/sandboxes-and-worktrees.md) |
| Chat output tags (`<task/>`, `<proposal>`, `<ask>`, etc.) | [docs/chat-tags.md](./docs/chat-tags.md) |
| Workflow engine | [docs/workflows.md](./docs/workflows.md) |
| Skills: SKILL.md install + enable per agent (CLI + UI) | [docs/skills.md](./docs/skills.md) |
| Trusted-actions HITL gateway (Amazon purchases) — setup, runbook, threat model, roadmap | [docs/trusted-actions.md](./docs/trusted-actions.md) + [runbook](./docs/trusted-actions-runbook.md) + [threats](./docs/trusted-actions-threats.md) + [roadmap](./docs/trusted-actions-roadmap.md) |
| Browser mediator — flexible browser surface with vault refs + workflow learning (6-phase build) | [docs/browser-mediator-design.md](./docs/browser-mediator-design.md) |
| Publishing to npm — one-time setup, per-release flow, troubleshooting | [docs/publishing.md](./docs/publishing.md) |

When touching a subsystem, update its doc — keep this index file tight.
