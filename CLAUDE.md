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
pnpm run eval -- --home ~/.tailored-ai   # scenario benchmark against a live model
pnpm run eval:compare -- a.json b.json   # diff two benchmark runs
pnpm run eval -- bench                   # sweep a simulation's baselines (no model calls)
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
| `@tailored-ai/provider-deepseek` | `packages/provider-deepseek/` | DeepSeek model provider plugin (OpenAI-compatible) | `@tailored-ai/core` peer |
| `@tailored-ai/deploy-aws` | `packages/deploy-aws/` | AWS deploy target plugin (`tai deploy up aws-ec2`) | `@tailored-ai/core` peer |
| `@tailored-ai/trusted-actions` | `packages/trusted-actions/` | HITL executor for approval-gated actions | `@tailored-ai/core` |
| `@tailored-ai/site` | `packages/site/` | Next.js docs site | private |
| `@tailored-ai/integration-tests` | `packages/integration-tests/` | End-to-end CLI/plugin/server smoke scenarios | private |
| `@tailored-ai/evals` | `packages/evals/` | Scenario benchmark: real invocation message → live model → score | private |

- ESM project (`"type": "module"` in all packages)
- Internal imports within a package use relative `.js` extensions (Node16 module resolution)
- Cross-package imports use the `@tailored-ai/*` workspace specifier
- SQLite via `better-sqlite3` (synchronous API)
- Config via `config.yaml` with `${ENV_VAR}` interpolation
- Published CLI package is `@tailored-ai/cli`; current public install path is `npm install -g @tailored-ai/cli`

## Where logic goes

Before writing a feature, decide which tier it belongs to. Every change fits exactly one:

1. **Core platform** (`packages/core`, plus the platform paths of `server`/`cli`) — the most sacred code. Modify it only for platform capabilities that enable plugins/components broadly: new seams (interfaces, registries, config selection), contract fixes, loop/runtime correctness. A feature that serves one use case does not belong here, even a popular one. Core must never know a plugin's name or config shape.
2. **Built-in plugins/packages** (`packages/google-tools`, `packages/channel-slack`, `packages/core/src/plugins/builtin:*`, etc.) — common functionality that multiple people could use. Low scrutiny to add; ships in this repo and may be bundled, but registers through the same registries as a third-party plugin and must be fully removable/replaceable without breaking core.
3. **Deployment logic** — anything specific to one installation: lives in that deployment's own config repo and its `<TAI_HOME>/config.yaml`, never in this repo. If a change only makes sense for one deployment, it goes there.

When a feature needs core changes to be buildable as a plugin (a missing seam), split the work: land the seam in core (tier 1) and the feature as a plugin (tier 2). The seam PR should make sense without the plugin.

## Current Direction

TAI is a modular framework for running personal agents. Keep docs and APIs oriented around replaceable components with intelligent defaults:

- Models/providers: OpenAI-compatible built in (local gateways); OpenAI, Anthropic, OpenRouter, Bedrock, and future vendors as provider plugins.
- Messaging protocols/channels: Discord built in; Slack and future GitHub/Telegram/email/etc. as plugins.
- UI: bundled web UI by default, replaceable through the UI provider registry.
- Agents/skills/tools/resources/workflows/task backends/repo backends/sandboxes: interfaces + registries + config selection where practical.
- Plugins: install through `tai plugin` into `<TAI_HOME>/plugins/`; support npm specs, git URLs, tarballs, and local `file:` packages.
- Status: working end-to-end, still in active development. Prefer accurate "what works today" wording over polished but aspirational claims.

## Key Design Decisions

- **Prompts and tool sets earn their size**: instructions and tools compete for the model's attention and for the history budget, so cut what isn't pulling weight. No fixed ceiling — this file used to give one (500-token prompts, ~5 tools), measured on the small local model of the day and since falsified: a 27-31B model took a ~1100-character persona better than a thin one, and the reference deployment runs 41 tools. Measure on the model you ship, don't trust a remembered limit.
- **No conditional response tokens**: never use patterns like "reply NO_REPLY if...". Smaller models read the sentinel as the answer. The general failure — an instruction that offers a way out gets taken — is still live, so only offer one where you genuinely want silence.
- **Low temperature**: default 0.3 for deterministic tool selection.
- **Simple agent loop**: No complex state machines. Loop: chat → tool calls → chat → stop.
- **Hot-reloadable runtime, within limits**: `reload()` re-reads config and rebuilds tools, provider and time provider; the agent loop re-resolves tools each iteration, so those changes take effect without restart. Channels are reconciled per config block, so only a transport whose own block changed restarts. What reload does *not* do is unwind a plugin: it clears the event bus wholesale and re-runs every plugin, so anything else a plugin owns — timers, sockets, pollers, HTTP routes — is the plugin author's to clean up via the disposers registration now returns ([architecture.md](./docs/architecture.md#registration-disposers)). Don't assume "hot-reloadable" means a plugin can be removed cleanly at runtime; that is [#533](https://github.com/quintonmiller/tailored-ai/issues/533).
- **Replaceable opinions**: Default behavior should be useful, but workflow opinions should move toward plugins/event subscribers instead of hardcoded core paths.

## Examples use a neutral cast

This is a public repo, so every example in it is read by people who have none of
your setup. Docs, test fixtures, benchmark scenarios, config samples and issue
text all describe the framework, never the machine it was written on.

- **Agents in examples get role names** — `assistant`, `planner`, `trip-planner`,
  `mail-sorter`, `room-keeper`, `reviewer`. Never paste a real deployment's agent
  roster: it reads as canonical, spreads by copy-paste, and ends up in shipped
  code comments and published CHANGELOGs, which is exactly how it got there
  before.
- **Paths are relative, `~/`, or `<TAI_HOME>`.** A container or fixture account
  (`/home/executor`, `/home/test`) is fine — that really is the user. A real
  person's home directory or checkout path is not.
- **Issues describe a capability, not an errand.** "Support multiple TAI
  instances on one machine", not "Split my TAI into work and personal". The
  deployment steps belong in the issue body as an example, not in its title.
- **Measurements keep their numbers and lose their owner.** "A 41-tool
  deployment spends ~10,900 tokens on schemas" is evidence; whose deployment it
  was is not.

`pnpm run guard:local-refs` enforces the structural half (home paths, checkout
paths, a deployment's config-repo names) and runs in CI. The naming half is not
mechanically detectable — `mail-sorter` and `email-classifier` look identical to
a regex — so it lives here.

## Conventions

- No default parameter values that duplicate config defaults (config.ts `DEFAULT_CONFIG` is the single source of truth)
- All configurable values go in `config.yaml` / `AgentConfig`
- Tool descriptions: 1-2 sentences. Long ones crowd the request without helping selection
- Prefer `node:` prefixed imports for Node.js built-ins
- **Releases stay on 0.x** until a deliberate V1. Mark **every changeset `patch`** — pre-1.0 a `minor`/`major` on `core` escalates the whole `fixed` group to `1.0.0`. npm publish is **manual + approval-gated** (`workflow_dispatch` + the `npm-publish` environment; never on push). CI runs `pnpm run guard:pre-v1`, which fails the build if any publishable version is `>= 1.0.0` or any changeset isn't `patch`. See [docs/publishing.md](./docs/publishing.md).

## Subsystem index

Deep notes on each subsystem live under [`docs/`](./docs/):

| Topic | Doc |
|---|---|
| AgentRuntime, factories, adding tools/channels/providers, admin tool, context slots | [docs/architecture.md](./docs/architecture.md) |
| Agent loop: history compaction, validation, retry, timing, providers | [docs/agent-loop.md](./docs/agent-loop.md) |
| Context assembly (proposal): tiering the request, record vs view, slot + composer registries | [docs/context-assembly-design.md](./docs/context-assembly-design.md) |
| Choosing a cloud model, falling back off local vLLM: measured cost/cache, provider quirks, `scripts/tai-model.mjs` | [docs/model-fallbacks.md](./docs/model-fallbacks.md) |
| Named agents, delegation, hooks, cron jobs, prompt expansion | [docs/agents-and-hooks.md](./docs/agents-and-hooks.md) |
| Background tasks, project tasks, pluggable backends, autopilot | [docs/tasks-and-autopilot.md](./docs/tasks-and-autopilot.md) |
| Repo backend (forge seam): push branch + manage proposals (PR/MR), default `gh` impl, events | [docs/repo-backend.md](./docs/repo-backend.md) |
| Tiered memory (recall, embeddings, promotion, sweep, HTTP/UI) | [docs/memory.md](./docs/memory.md) + design [docs/memory-tiers.md](./docs/memory-tiers.md) + storage-registry [docs/memory-storage-registry.md](./docs/memory-storage-registry.md) |
| Sandboxes (host/docker/podman) and `git worktree` helpers | [docs/sandboxes-and-worktrees.md](./docs/sandboxes-and-worktrees.md) |
| Chat output tags (`<task/>`, `<proposal>`, `<ask>`, etc.) | [docs/chat-tags.md](./docs/chat-tags.md) |
| Notifications: repeat suppression for unsolicited messages (`NotificationGate`) | [docs/notifications.md](./docs/notifications.md) |
| Rooms: shared multi-agent conversations (backend seam, envelopes, subscriptions, wake policy) | [docs/rooms.md](./docs/rooms.md) + archiving design [docs/rooms-archive-design.md](./docs/rooms-archive-design.md) |
| Schedules: agents booking their own future wakes (`schedule` tool, poll tick, room vs session targets) | [docs/schedules.md](./docs/schedules.md) |
| Workflow engine | [docs/workflows.md](./docs/workflows.md) |
| Skills: SKILL.md install + enable per agent (CLI + UI) | [docs/skills.md](./docs/skills.md) |
| Dashboard widgets: declarative Board seam (core registry + `/api/dashboard` + UI renderers) | [docs/dashboard-widgets.md](./docs/dashboard-widgets.md) |
| Trusted-actions HITL gateway (Amazon purchases) — setup, runbook, threat model, roadmap | [docs/trusted-actions.md](./docs/trusted-actions.md) + [runbook](./docs/trusted-actions-runbook.md) + [threats](./docs/trusted-actions-threats.md) + [roadmap](./docs/trusted-actions-roadmap.md) |
| Browser mediator — flexible browser surface with vault refs + workflow learning (6-phase build) | [docs/browser-mediator-design.md](./docs/browser-mediator-design.md) |
| Publishing to npm — one-time setup, per-release flow, troubleshooting | [docs/publishing.md](./docs/publishing.md) |
| MCP client: config-declared servers, tool discovery, lifecycle | [docs/mcp.md](./docs/mcp.md) |
| ACP client: drive an external coding agent over a real session (`coding_agent` tool, permission policy) | [docs/acp.md](./docs/acp.md) |
| Media: content parts, the content-addressed media store, model/surface capabilities, and the degradation ladder — in and out, across models, tools, channels, the UI and the CLI | [docs/media-design.md](./docs/media-design.md) |
| Running two instances (work/personal) on one machine: what `TAI_HOME` isolates and what leaks | [docs/multi-instance.md](./docs/multi-instance.md) |
| Self-hosting: Docker image, headless `tai init --non-interactive`, exposure/auth options, backups | [docs/self-hosting.md](./docs/self-hosting.md) |
| Deploy targets (`tai deploy` seam): contract in core, registry in CLI, built-in `docker`, writing a cloud plugin | [docs/deploy-targets.md](./docs/deploy-targets.md) |
| Benchmarking against a live model: scenarios, scoring, comparing runs, publishing to `/bench`, and simulations (an objective instead of an answer, with non-model baselines) | [docs/evals.md](./docs/evals.md) |
| **Defensive patterns — bug classes that shipped here, each stated as the rule that prevents it.** Read before lifecycle, teardown, config, provider, or prompt-assembly work | [docs/defensive-patterns.md](./docs/defensive-patterns.md) |
| Config catalog — every `DEFAULT_CONFIG` field, its default, and whether anything reads it. Generated; `pnpm run gen:catalogs` | [docs/config-catalog.md](./docs/config-catalog.md) |
| Tool catalog — every registered tool factory, its real config gate, and whether that gate has a default. Generated | [docs/tool-catalog.md](./docs/tool-catalog.md) |
| Audit findings + open action items (2026-07-28): boundaries, trust, skills, context | [docs/audit-2026-07-28.md](./docs/audit-2026-07-28.md) |

When touching a subsystem, update its doc — keep this index file tight.
