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

- **OpenAI-compatible** (`packages/core/src/providers/openai.ts`, `id: "openai_compatible"`) — generic `POST /v1/chat/completions` client for any OpenAI-wire-format server: **vLLM**, **Ollama** (`/v1` endpoint), **LM Studio**, **llama.cpp server**, **text-generation-webui**. `apiKey` is optional — when omitted no `Authorization` header is sent. Configure under `providers.openai_compatible` with required `baseUrl` (must include `/v1`) and `defaultModel`. Optional `name` controls the label shown in logs/UI.
- **OpenAI** (`packages/core/src/providers/openai.ts`, `id: "openai"`) — hosted OpenAI; requires `apiKey`. Same wire format as openai_compatible but always sends auth.
- **Anthropic** (`packages/core/src/providers/anthropic.ts`) — Anthropic Messages API.

Both `openai_compatible` and `openai` share `OpenAIProvider`; the only differences are auth-header behavior and the `id`/`name` reported on the instance.

**Back-compat**: configs that still use `providers.ollama` (the removed native `/api/chat` provider) are auto-migrated to `providers.openai_compatible` at load time by appending `/v1` to the base URL. A deprecation warning is printed.

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

## Prompt Expansion

`packages/core/src/prompts/expand.ts` provides `expandPrompt(text, vars, options?)` for rendering prompt templates. Three forms, applied in order:

1. **`{{include:path}}`** — file inclusion. Relative paths resolve against `options.baseDir` (default `process.cwd()`). Included content is itself expanded recursively, with depth capped by `options.maxIncludeDepth` (default 5). Missing files become an inline `[include error: ...]` marker rather than throwing.
2. **`{{var}}`** — variable substitution from `vars`. Same shape as the legacy `applyTemplates` (which is now an alias for `applyVars`).
3. **`` !`shell cmd` ``** — inline shell expansion. Runs the command via `bash -c`, substitutes its trimmed stdout. Off by default; enable with `prompts.allowShellExpansion: true` in config. Errors become `[!shell error: ...]` so the agent can see what failed.

Wired into:
- `cron/scheduler.ts` — full expansion for `job.prompt` (cron prompts can pull in `!`git log -3``, etc.)
- `task-watcher.ts` — full expansion for `config.prompt`
- `agent/hooks.ts` — `executeHooks` expands string-valued hook args (so a hook `args: { content: "!`date`" }` works)

Static agent instructions (`agents.<name>.instructions`) are *not* currently expanded — they're loaded once and don't benefit from per-iteration shell calls. If you need dynamic instructions, use a cron `beforeRun` hook to write to a memory file and reference it.

Config:

```yaml
prompts:
  allowShellExpansion: false   # gate shell expansion behind this
  shellTimeoutMs: 5000
  maxIncludeDepth: 5
```

## Worktrees

`packages/core/src/worktree.ts` is a thin wrapper over `git worktree` for running an agent in an isolated branch and merging back. Built for the workflow runner (S5) but usable directly.

```ts
import { createWorktree } from "@agent/core";

const wt = await createWorktree({
  repoDir: ".",
  strategy: { type: "merge-to-head", branch: "agent/fix-42" },
});
// ...agent runs in wt.path...
const merged = await wt.mergeToHead?.();
if (!merged?.ok) console.log(`branch preserved: ${merged?.branchPreserved}`);
await wt.cleanup(); // removes if clean; preserves if dirty
```

Three strategies:
- `head` — no worktree; runs in `repoDir` on current branch. Cleanup is a no-op.
- `branch` — fresh worktree on a named branch. Cleanup removes if clean, preserves if dirty.
- `merge-to-head` — same as `branch` plus `mergeToHead()` that runs `git merge --no-ff <branch>` against the host repo. On conflict, aborts the merge (host left clean) and preserves the branch.

`autoStash(repoDir)` stashes only modified-tracked files (deliberately not untracked — matches the mmo sandcastle autostash pattern, so a `.worktrees/` dir doesn't get swept up). Returns `{ stashed, pop() }` for a try/finally.

## Workflows

`packages/core/src/workflows/` is a programmatic + declarative orchestration engine built on the agent loop. Workflows are sequences of named steps that thread outputs through a typed scope. Full design: [`docs/workflows.md`](./docs/workflows.md).

Step types:
- `agent_run` — runs the agent loop with a prompt and optional agent override
- `tool_call` — invokes a single tool with literal args
- `shell` — `bash -c` (only when `prompts.allowShellExpansion: true`)
- `condition` — branches on a JS-style expression evaluated against scope
- `loop` — repeats an inner pipeline over an array
- `parallel` — runs branches concurrently, waits for all

Storage: `workflow_runs` and `workflow_steps` tables in SQLite. Per-step logs under `data/workflow-runs/<run-id>/<step>.log` (retention configurable). Triggers: CLI (`run_workflow` tool), cron (`workflow:` field on a job), HTTP (`POST /api/workflows/:name/run` + SSE progress on `GET /api/workflow-runs/:id/events`), webhook routes, and the `dispatch_workflow` agent tool for fire-and-forget.

Workflow files live under `data/workflows/*.yaml` (configurable via `workflows.directory`). The `WorkflowRegistry` hot-reloads them from disk; `runtime.startWatchingWorkflows()` enables fs.watch.

Programmatic definition (TypeScript):
```ts
import { defineWorkflow, type WorkflowDefinition } from "@agent/core";

const wf: WorkflowDefinition = defineWorkflow({
  name: "review-pr",
  steps: [
    { name: "summarize", type: "agent_run", agent: "researcher", prompt: "Summarize PR ${input.pr_url}" },
    { name: "comment",   type: "tool_call", tool: "gh-comment",   args: { url: "${input.pr_url}", body: "${steps.summarize.output}" } },
  ],
});
```

The `AutopilotWorker` can route a claimed task tagged `workflow:<name>` through the engine instead of the standard agent loop — opt-in per task via tag.

## Autopilot

`packages/core/src/autopilot/worker.ts` is a long-running worker that wakes on an interval (default 30s), claims one backlog task per tick from the configured `TaskBackend`, and runs it through the agent loop or a workflow. Started by the CLI in server mode.

What it does each tick:
1. Read `autopilot_settings` (paused / quiet hours / disabled hours / token budget)
2. If past a budget cap, skip; if quiet hours, suppress notifications
3. Promote any tasks blocked due to budget back to backlog when the window rolls forward
4. Pick one backlog task whose `assignee` matches a configured agent name; claim atomically
5. Resolve the task's `project_id` to a `ProjectContext` (S7) so cwd + session scope match the project
6. Build a fresh session keyed `autopilot:<task.id>` (no carry-over history; comments are the durable memory)
7. Run the loop with a per-task `AbortController` so a single overrun doesn't cascade
8. On success, mark task `done` (or `in_review` if the agent flagged uncertainty); on error, comment + status `blocked` + DM the owner

Token usage is recorded per session/task in `token_usage`. Mid-task budget exhaustion aborts that task only; sibling conversations (chats, other autopilot runs) keep going.

Morning digest: a daily Cron (configurable via `digest_time` setting) runs `buildMorningDigest()` over `digest_runs` + recent activity and DMs the result to the Discord owner. Runs are persisted in `digest_runs`.

Notifications:
- `notifyNeedsHuman` DMs the owner when a task errors or is blocked, suppressed during quiet hours
- The web UI's "working on" strip subscribes via `getActivity()` for live status

The autopilot uses `runtime.getTaskBackend()` by default; tests override via `AutopilotWorkerOptions.taskBackend`. As of S7.5 the worker still claims one task per tick from a single backend — multi-project iteration with per-project backends is a follow-up bean.

## Sandboxes

Tool side-effects (shell, file IO) can be routed through a `Sandbox` defined in `packages/core/src/sandboxes/interface.ts`. Today:

- **`host`** (default) — `packages/core/src/sandboxes/host.ts`. Runs commands directly on the host. No isolation.
- **`docker`** — `packages/core/src/sandboxes/docker.ts`. Long-running container with the host cwd bind-mounted at `/work` (configurable). `prepare()` runs `docker run -d --rm -v <cwd>:/work -w /work --entrypoint sleep <image> infinity`; `exec()` runs `docker exec`; file IO goes through the bind-mount path on the host. `cleanup()` is best-effort `docker rm -f`.
- **`podman`** — `packages/core/src/sandboxes/podman.ts`. Same surface as `DockerSandbox` (rootless/CLI-compatible); both extend a shared `ContainerSandbox` base in `container.ts`. Config goes under `sandboxes.podman.{imageName, mounts, env, network, sandboxWorkdir}`.

Lifecycle: the runtime calls `createSandbox(config, agent)` in `buildLoopOptions()` and threads the result into `AgentLoopOptions.sandbox`. `runAgentLoop` calls `sandbox.prepare({ cwd })` before the loop body and `sandbox.cleanup(handle)` in a finally block. The handle lands on `ToolContext` as `sandbox` + `sandboxHandle`.

Tools opt in by checking for both fields and routing through `context.sandbox.exec(handle, cmd, opts)` / `readFile` / `writeFile`. `exec.ts`, `read.ts`, and `write.ts` are wired today. `HostSandbox.writeFile` and `DockerSandbox.writeFile` auto-create parent directories so tools don't need to mkdir themselves.

Config:

```yaml
agent:
  sandbox: host                # default for all agents
agents:
  coder:
    sandbox: docker            # per-agent override
sandboxes:
  docker:                      # required when any agent uses docker
    imageName: node:22-bookworm
    network: host              # optional
    sandboxWorkdir: /work      # optional, default /work
    mounts:                    # optional extras beyond cwd bind
      - { hostPath: ~/.npm, sandboxPath: /home/agent/.npm, readonly: true }
    env:                       # optional defaults
      NODE_ENV: development
```

`DockerSandbox` accepts an injected `runner: DockerRunner` for testability — tests substitute a fake; production uses `execFile('docker', ...)` directly.

## Task Backends

Project tasks (and the autopilot worker) read/write through a pluggable `TaskBackend` interface defined in `packages/core/src/tasks/interface.ts`. Today:

- **`native`** (default) — `packages/core/src/tasks/native.ts`, wraps the existing SQLite `project_tasks` table.
- **`github`** — `packages/core/src/tasks/github.ts`, drives an arbitrary GitHub repo's Issues. Status maps to labels: `status:backlog`, `status:in_progress`, `status:blocked`, `status:in_review`. A closed issue means done. Tags are non-status, non-reason labels. Rank is the issue number (lower = older = higher priority for the autopilot). Assignee is the first `assignees[]` entry. Blocked reason maps to `reason:<value>` labels. Comments preserve the agent's `agentName` by prepending `[agent: NAME] ` to the body when the name matches `[A-Za-z0-9._-]+`; on read, the prefix is stripped and the embedded name overrides the GH user attribution. Plain comments without the prefix still attribute to the GH commenter.
- **`beans`** — `packages/core/src/tasks/beans.ts`, shells out to the [beans](https://github.com/hmans/beans) CLI. Status maps: `backlog↔todo`, `in_progress↔in-progress`, `done↔completed`; `blocked` is encoded as `status=todo` plus a `status:blocked` tag (with optional `reason:*` tag for `blocked_reason`). Assignee is stored as a managed `assignee:NAME` tag (filtered out on read). beans-native `draft` and `scrapped` statuses are exposed verbatim via `extraStatuses`. Comments are appended to the body inside `<!-- beans-comment ... -->` markers and stripped from `description` on read. `claimBacklog` uses `--if-match <etag>` for optimistic concurrency. Accepts an injected `BeansRunner` for testability; production uses `execFile('beans', ...)`.
- **`beads`** — `packages/core/src/tasks/beads.ts`, shells out to the [beads](https://github.com/steveyegge/beads) `bd` CLI. Status maps natively (`backlog↔open`, `in_progress↔in_progress`, `blocked↔blocked`, `done↔closed`); the beads-native `deferred` is exposed via `extraStatuses`. Status transitions go through `bd close` / `bd reopen` / `bd set-state --reason` (a generic reason is supplied when the caller doesn't provide one). `claimBacklog` uses `bd update --claim`. Labels map 1:1 (no `assignee:` / `status:blocked` tag prefix gymnastics needed). Limitations: per-issue delete falls back to `bd close --reason deleted`, and `bd init` must have been run on the repo before the backend will work. Accepts an injected `BeadsRunner` for testability.

Backend resolution: `createTaskBackend(config, db)` in `packages/core/src/tasks/factory.ts`. The autopilot worker constructs its own backend in the constructor; pass `taskBackend` in `AutopilotWorkerOptions` to override (used by tests).

Every backend declares its native status enum via `statuses: { backlog, inProgress, blocked, done }` and an `isDone(status)` predicate, so autopilot logic ("claim a backlog task", "mark blocked due to budget") is portable.

The `tasks` and `task_query` agent tools still go directly to SQLite — migrating them to the backend interface is tracked as a follow-up bean.

Config:

```yaml
tasks:
  backend: github           # native | github | beans | beads
  github:                   # required when backend: github
    repo: owner/repo
    token: ${GITHUB_TOKEN}
  beans:
    path: ./.beans
  beads:
    path: ./.beads
```

When using the `github` backend, `AutopilotWorker.start()` calls `backend.bootstrap()` once on launch — this creates the four `status:*` labels (`backlog`, `in_progress`, `blocked`, `in_review`) and `reason:budget` with sensible colors if they're missing. Idempotent and non-fatal: missing-permissions or 422-already-exists errors are swallowed. Backends declare bootstrap as optional on `TaskBackend`; only `github` implements it today.

## Adding a Cron Job

1. Add job config under `cron.jobs` in `config.yaml` (see `CronJobConfig` in `packages/core/src/config.ts`)
2. Set `cron.enabled: true`
3. Run with `--serve` — the scheduler starts automatically
4. Two modes: `wakeAgent: true` (default) runs agent loop; `wakeAgent: false` injects a note into the session
5. Delivery channels: `log` (default, stdout) or `discord` (requires `delivery.target` channel ID)
6. Job state is tracked in the `cron_jobs` DB table
7. Cron jobs can define their own `hooks` and also inherit hooks from their `agent` (agent hooks run first, job hooks appended). See the Hooks section above.

## Projects (per-project mode)

By default tai is global: one home dir (`~/.tailored-ai/` or `TAI_HOME`), one config, one DB, one Discord bot, one cron scheduler. Per-project mode lets a single tai brain manage N registered repos by threading a `project_id` through sessions, tasks, cron, autopilot, and Discord — without forking the install or going multi-process.

### Registering a project

```bash
cd ~/repos/my-app
tai project init --name "My app"      # writes .tai.yaml, registers in DB
tai project list                       # see all registered projects (current dir marked *)
tai project show                       # inspect the current dir's project
tai project add ~/repos/other          # register a path lazily (no .tai.yaml written)
tai project remove proj_abc12345       # archive (status=archived); --hard for real DELETE
```

`.tai.yaml` shape:

```yaml
project:
  id: proj_abc12345         # set by `init`, immutable
  name: "My app"            # human label; defaults to dirname
config:                     # optional overlay merged over global config.yaml
  agent:
    temperature: 0.5
  agents:
    coder:                  # deep-merged with the global agents.coder
      tools: ["read", "write", "exec"]
  tasks:
    backend: github         # this project uses GitHub Issues; others stay native
```

### How resolution works

When you run any `tai ...` command from inside a registered repo, the CLI walks up from cwd looking for `.tai.yaml`. If found, it reads `project.id`, looks up the DB row, and calls `runtime.setActiveProject(...)` — the overlay merges into the live config and any new sessions created in that run get the project_id stamped on them.

If there's no `.tai.yaml` on disk but the cwd is inside a registered project's `path` (the lazy-mode case), the resolver still finds it via ancestor lookup.

CLI overrides:
- `--project <id>` — scope to a specific project regardless of cwd
- `--global` — force global mode even inside a registered repo
- `--list-sessions --project <id>` — filter the session list

### Config overlay semantics (`mergeProjectOverlay` in config.ts)

- Maps deep-merge (project keys override global; new keys added)
- Arrays replace wholesale (no concat)
- `agents.<name>` deep-merges so a project can override one field without redefining the whole agent
- Validation warnings introduced by the overlay are tagged `[project:<id>] Warning:` so the source is visible

### What's project-scoped

- **Sessions** carry `project_id`; CLI flags `--project <id>` and `--global` filter `--list-sessions`.
- **Agent loop cwd**: tools and sandboxes operate against the active project's `path` rather than `process.cwd()`.
- **Cron jobs**: `CronJobConfig.project: <id>` binds a job to a project. Session keys auto-namespace to `cron:<projectId>:<name>`. Jobs declared in a project's `.tai.yaml` overlay only fire when that project is the runtime's active one (single-tenant constraint of S7).
- **Autopilot**: tasks with `project_id` run with that project's path as cwd; the worker still uses one task backend per tick (multi-backend iteration is a future bean).
- **Discord**: `channels.discord.projectMappings` binds guild channels or DMs to a project. Matched messages get `discord:<projectId>:<userId>` session keys. Unmapped messages stay global.
- **HTTP**: `GET /api/sessions?project=<id>` filters by project (or `?project=global` for un-scoped).
- **UI**: header `<select>` (ProjectSwitcher) persists selection to `localStorage["tai.activeProjectId"]`. Pages that opt in via the `useActiveProject()` hook re-fetch on change.

### Going to "all projects in parallel" later

The project_id threading done here is a prerequisite for ever upgrading to a workspace daemon model where multiple projects' loops run concurrently. S7 stays single-tenant on purpose — runs serialize, one Discord bot, one cron scheduler — but isolation along the project_id axis is preserved so a future Slice 8 (or external supervisor) can fan that out.

## Conventions

- No default parameter values that duplicate config defaults (config.ts `DEFAULT_CONFIG` is the single source of truth)
- All configurable values go in `config.yaml` / `AgentConfig`
- Tool descriptions: 1-2 sentences max (for local model compatibility)
- Prefer `node:` prefixed imports for Node.js built-ins
