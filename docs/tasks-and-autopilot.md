# Tasks, Task Backends & Autopilot

In-process task registry, persistent project tasks, pluggable backends, and the autopilot worker.

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
  backend: github           # any registered backend id; built-ins: native | github | beans | beads
  options:                  # backend-specific, opaque to core — the selected backend reads it
    repo: owner/repo        #   github: repo + token (+ optional agentRoles)
    token: ${GITHUB_TOKEN}
    # beans/beads read: path
```

`backend` is resolved through the task-backend registry, so a third-party
backend id works the same as a built-in. Backend-specific settings live in
the opaque `options` bag the selected backend reads itself — core privileges
no built-in. The legacy `tasks.github` / `tasks.beans` / `tasks.beads` blocks
are still accepted and folded into `tasks.options` at load with a deprecation
warning.

When using the `github` backend, `AutopilotWorker.start()` calls `backend.bootstrap()` once on launch — this creates the four `status:*` labels (`backlog`, `in_progress`, `blocked`, `in_review`) and `reason:budget` with sensible colors if they're missing. Idempotent and non-fatal: missing-permissions or 422-already-exists errors are swallowed. Backends declare bootstrap as optional on `TaskBackend`; only `github` implements it today.

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

## Briefing surface

The morning digest is delivered out-of-band (default channel). The **briefing** is the on-demand, in-UI counterpart: an LLM-written greeting/summary the web UI shows at the top of Home. It is off by default, so there's no behavior or token cost unless a user enables it.

`packages/core/src/briefing.ts` exposes `generateBriefing(runtime)`. It assembles a compact, **data-only** context from the same queries that feed the Dashboard — blocked tasks, pending workflow forms, tasks completed in the last ~24h, recent completed/failed workflow runs, enabled cron jobs, and recent `session-summary` notes — capping each list (5) and the whole context (~1500 chars) so it stays local-model friendly. It then runs **one** provider completion using the system prompt from `config.briefing.prompt`.

Config (ships in `DEFAULT_CONFIG`, all optional, disabled):

```yaml
briefing:
  enabled: false        # master switch — when false the endpoint returns { enabled: false } with no provider call
  prompt: <generic default>   # system prompt; replaceable per install (config is the seam, not core)
  ttlMinutes: 30        # cache freshness window
  model: ""             # optional model override against the active provider; omit to use the runtime default
```

Default prompt: *"You are the user's personal assistant. Write a brief, friendly briefing from the data below: a 1-2 sentence greeting summarizing the situation, then up to 3 bullet points of what needs attention, then 1 line of what's coming up. Plain language, under 120 words, no headers."*

Endpoints (`packages/server`):
- `GET /api/briefing` — `{ enabled: false }` when disabled (no provider call). When enabled, returns `{ enabled: true, content, generatedAt, stale }`: serves a fresh cached result within `ttlMinutes`, otherwise generates one. Generation is cached in process memory and single-flighted, so concurrent requests await the same completion.
- `POST /api/briefing/refresh` — force a regenerate; `429` if a generation is already running.

Model override: `briefing.model` swaps the model used against the active provider. A per-agent override (resolving a *different* provider via `resolveAgent`) was scoped but deferred — wiring a distinct provider instance per agent is heavier than the model swap, so it's a follow-up; use `model` for now.
