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
- **`github`** — `packages/core/src/tasks/github.ts`, drives an arbitrary GitHub repo's Issues. Status maps to labels: `status:backlog`, `status:in_progress`, `status:blocked`, `status:in_review`. A closed issue means done. Tags are non-status, non-reason labels. Rank is the issue number (lower = older = higher priority for the autopilot). Assignee is the first `assignees[]` entry — **unless** it's a known TAI agent role, in which case it rides on an `agent:<name>` label instead (GitHub 422s on `assignees: ["coder"]` because "coder" isn't a real collaborator). The agent-role set is **derived from your config** (#204), not a hardcoded list: every name under `agents:`, plus `taskWatcher.agent`, plus any `tasks.options.agentRoles`. Blocked reason maps to `reason:<value>` labels. Comments preserve the agent's `agentName` by prepending `[agent: NAME] ` to the body when the name matches `[A-Za-z0-9._-]+`; on read, the prefix is stripped and the embedded name overrides the GH user attribution. Plain comments without the prefix still attribute to the GH commenter.
- **`beans`** — `packages/core/src/tasks/beans.ts`, shells out to the [beans](https://github.com/hmans/beans) CLI. Status maps: `backlog↔todo`, `in_progress↔in-progress`, `done↔completed`; `blocked` is encoded as `status=todo` plus a `status:blocked` tag (with optional `reason:*` tag for `blocked_reason`). Assignee is stored as a managed `assignee:NAME` tag (filtered out on read). beans-native `draft` and `scrapped` statuses are exposed verbatim via `extraStatuses`. Comments are appended to the body inside `<!-- beans-comment ... -->` markers and stripped from `description` on read. `claimBacklog` uses `--if-match <etag>` for optimistic concurrency. Accepts an injected `BeansRunner` for testability; production uses `execFile('beans', ...)`.
- **`beads`** — `packages/core/src/tasks/beads.ts`, shells out to the [beads](https://github.com/steveyegge/beads) `bd` CLI. Status maps natively (`backlog↔open`, `in_progress↔in_progress`, `blocked↔blocked`, `done↔closed`); the beads-native `deferred` is exposed via `extraStatuses`. Status transitions go through `bd close` / `bd reopen` / `bd set-state --reason` (a generic reason is supplied when the caller doesn't provide one). `claimBacklog` uses `bd update --claim`. Labels map 1:1 (no `assignee:` / `status:blocked` tag prefix gymnastics needed). Limitations: per-issue delete falls back to `bd close --reason deleted`, and `bd init` must have been run on the repo before the backend will work. Accepts an injected `BeadsRunner` for testability.

Backend resolution: `createTaskBackend(config, db)` in `packages/core/src/tasks/factory.ts`. The autopilot worker constructs its own backend in the constructor; pass `taskBackend` in `AutopilotWorkerOptions` to override (used by tests).

Every backend declares its native status enum via `statuses: { backlog, inProgress, blocked, done }` and an `isDone(status)` predicate, so autopilot logic ("claim a backlog task", "mark blocked due to budget") is portable.

The `tasks` and `task_query` agent tools still go directly to SQLite — migrating them to the backend interface is tracked as a follow-up bean.

### `task_query` makes you say whose tasks you mean

`assignee` is required. There is no default, deliberately:

```
task_query(assignee="me")                       your own work
task_query(assignee="all", status="backlog")    the whole queue
task_query(assignee="unassigned")               tasks nobody owns
task_query(assignee=["coder", "reviewer"])      a named subset
```

It used to default to everyone, which reads as harmless until an agent is asked
what it is working on. In this deployment the only two `in_progress` rows were
the owner's reading list — a novel and an audiobook, both unassigned — and
several agents reported them as work in flight. Because that claim then lived in
each agent's own session, later status updates repeated it without querying
anything at all, and the book title `REAMDE` drifted into "generating a README in
Neal Stephenson's style".

No default fixes that. "Everyone" is wrong for an agent reporting on itself;
"me" is wrong for a planner surveying the board. Omitting it returns an error
naming the four options, which the model gets one round to act on.

`unassigned` is a real value rather than the absence of a filter, so "nobody owns
this" and "I didn't ask" stay distinct — conflating them is what made an
unowned task look available, and therefore look like yours.

Config:

```yaml
tasks:
  backend: github           # any registered backend id; built-ins: native | github | beans | beads
  options:                  # backend-specific, opaque to core — the selected backend reads it
    repo: owner/repo        #   github: repo + token (+ optional agentRoles to extend the derived role set)
    token: ${GITHUB_TOKEN}
    # beans/beads read: path
```

`backend` is resolved through the task-backend registry, so a third-party
backend id works the same as a built-in. Backend-specific settings live in
the opaque `options` bag the selected backend reads itself — core privileges
no built-in. The legacy `tasks.github` / `tasks.beans` / `tasks.beads` blocks
are still accepted and folded into `tasks.options` at load with a deprecation
warning.

**Agent-role derivation.** The factory (`createTaskBackend` in `tasks/factory.ts`) builds the github backend's agent-role set from the install's own config: the union of `config.agents` keys, `config.taskWatcher.agent`, and `tasks.options.agentRoles`. There is no built-in default list — if you don't define any agents and don't set `agentRoles`, every assignee is treated as a real GitHub user. Names in the set route to `agent:<name>` labels (and `nextBacklogTask` / `query` filter on those labels) instead of GH's assignees API.

When using the `github` backend, `AutopilotWorker.start()` calls `backend.bootstrap()` once on launch — this creates the four `status:*` labels (`backlog`, `in_progress`, `blocked`, `in_review`) and `reason:budget` with sensible colors if they're missing. Idempotent and non-fatal: missing-permissions or 422-already-exists errors are swallowed. Backends declare bootstrap as optional on `TaskBackend`; only `github` implements it today.

## Autopilot

`packages/core/src/autopilot/worker.ts` is a long-running worker that wakes on an interval (default 30s), claims one backlog task per tick from the configured `TaskBackend`, and runs it through the agent loop or a workflow. Started by the CLI in server mode.

What it does each tick:
0. Check the deployment-wide [pause switch](./architecture.md#the-global-pause-switch). `autopilot_settings.paused` stops autopilot; `/pause` stops everything, so the owner does not have to remember which of six subsystems is running in order to stop the spending. The same switch also stops the stuck-task re-dispatch scan, stall retries, and the tasks tool handing work to another agent — the paths that re-fire an agent without a person asking.
1. Read `autopilot_settings` (paused / quiet hours / disabled hours / token budget)
2. If past a budget cap, skip
3. Promote any tasks blocked due to budget back to backlog when the window rolls forward
4. Pick one backlog task whose `assignee` matches a configured agent name; claim atomically
5. Resolve the task's `project_id` to a `ProjectContext` (S7) so cwd + session scope match the project
6. Build a fresh session keyed `autopilot:<task.id>` (no carry-over history; comments are the durable memory)
7. Run the loop with a per-task `AbortController` so a single overrun doesn't cascade
8. On success, mark task `done` (or `in_review` if the agent flagged uncertainty); on error, comment + status `blocked` + emit `task.needs_human`

Mid-task budget exhaustion aborts that task only; sibling conversations (chats, other autopilot runs) keep going.

### Token accounting

`runAgentLoop` writes one `token_usage` row per provider call, so **every** call
is counted — chat, room wakes, cron and delegation as well as autopilot and
exploratory. It records before invoking the caller's `onUsage`, so a consumer
that throws cannot cost the accounting row.

Rows carry `agent` and `source`:

| source | what it covers |
|---|---|
| `loop` | default — chat, room wakes, cron, delegation |
| `autopilot` | task-watcher dispatches (also carries `task_id`) |
| `exploratory` | exploratory ticks |

**The autopilot budget is scoped to `BUDGETED_TOKEN_SOURCES`** (`autopilot` +
`exploratory`), which is what `token_usage` held when the caps were written.
Counting everything would let a busy hour in the rooms pause autopilot for
reasons that have nothing to do with autopilot. Rows predating the column have a
NULL source and still count, because that is what they were — and a direct
`recordTokenUsage` that omits the source stores NULL for the same reason, so an
external caller doesn't silently fall out of the budget.

Read it back with `GET /api/usage?hours=24` (deployment-wide, grouped by source
and by agent) or `GET /api/autopilot/usage` (budgeted scope, alongside the caps).

Morning digest: a daily Cron (configurable via `digest_time` setting) runs `buildMorningDigest()` over `digest_runs` + recent activity and emits `digest.ready`. Runs are persisted in `digest_runs`.

### Task prompt (`autopilot.taskPrompt`)

The orchestration rules the worker hands an agent are an overridable template, `config.autopilot.taskPrompt`, expanded by `buildTaskPrompt()` (`packages/core/src/autopilot/task-prompt.ts`). `DEFAULT_CONFIG` ships `DEFAULT_AUTOPILOT_TASK_PROMPT` (the rules verbatim), so behavior is unchanged unless you override it. Template vars: `{{task_id}}`, `{{task_title}}`, `{{task_description}}`, `{{prior_activity}}` (the rendered recent-comment block, or empty when there are none). Precedent: `briefing.prompt` / `suggestions.prompt`.

### Notification seams (events)

Core no longer decides *who* to notify or *how*. The worker, the `ask_user` tool, and the `channel_message` workflow executor emit typed runtime events instead of DMing the owner inline; the default **`builtin:owner-notifier`** plugin (`packages/core/src/plugins/owner-notifier.ts`) subscribes and delivers — same channel/recipient resolution (`runtime.resolveOutbound()` + `runtime.getOwnerId()`) and the same autopilot quiet-hours suppression that lived inline. It ships enabled in `DEFAULT_PLUGIN_MODULES`, so out-of-the-box delivery is identical to before.

| Event | Emitted by | Owner-notifier delivery |
|---|---|---|
| `task.needs_human` | worker error/block path | owner DM, suppressed during quiet hours |
| `digest.ready` | `runDigest()` | owner DM, never suppressed |
| `question.asked` | `ask_user` tool | owner DM; the autopilot variant (carries `taskId`) is quiet-hours-suppressed, plain questions always deliver |
| `form.completed` | `channel_message` step's implicit owner-DM fallback | owner DM |

To ship somewhere else (Slack, Telegram, email, a pager): disable the plugin (`plugins: - { module: "builtin:owner-notifier", enabled: false }`) and subscribe your own handler to these events via `ctx.events.on(...)`. The `channel_message` executor only routes through `form.completed` for the fully-implicit "DM the owner" case (no explicit `channelId` / `userId` / per-step `channel`); explicit targets stay direct deliveries.

The web UI's "working on" strip still subscribes via `getActivity()` for live status.

The autopilot uses `runtime.getTaskBackend()` by default; tests override via `AutopilotWorkerOptions.taskBackend`. As of S7.5 the worker still claims one task per tick from a single backend — multi-project iteration with per-project backends is a follow-up bean.

## Verification gate

By default nothing stops an agent (or the autopilot finalizer) from setting a
task `done` without proving the work — a `done` is an assertion, not evidence.
The **`builtin:verify-gate`** plugin (`packages/core/src/plugins/verify-gate.ts`,
seeded `enabled: false`) closes that hole. It subscribes to `task.transitioned`
and, when a task reaches the backend's `done` status without a recorded
verification verdict, routes it back to the review stage instead of letting it
close.

The contract is a **convention, not a schema**:

- The task creator writes an **`## Acceptance`** section (and a `verify:` shell
  command when one exists) in the description — the observable check that proves
  the task is done.
- The reviewing agent runs that check and posts a comment whose latest verdict
  is `VERIFY: PASS` (with evidence) or `VERIFY: FAIL`. The gate only lets `done`
  stand when the most recent reviewer verdict is `PASS`; the gate's own
  bookkeeping comments are ignored.
- An unverified `done` is reverted to `in_review`, re-assigned to the reviewer,
  and a `task.dispatch_requested` is emitted so the watcher re-runs the
  reviewer. After `maxBounces` rounds it stops and emits `task.needs_human`, so
  a task can't loop forever.

It hardcodes no agent name. Config (`{ module: "builtin:verify-gate", config: … }`):

```yaml
- module: builtin:verify-gate
  config:
    reviewerAssignee: reviewer       # default bounce target
    reviewerByTag:                   # per-kind override, checked first
      kind:config: verifier          #   live-surface → non-worktree verifier (curls the running app)
      kind:code: reviewer            #   repo change → worktree reviewer (builds/tests the branch)
    requireTags: [kind:code, kind:config]  # only gate tagged work; PA tasks self-close
    maxBounces: 2                    # then escalate to a human
    # passMarker / failMarker / doneStatus / reviewStatus are overridable too
```

`reviewerByTag` matters because the two kinds verify differently: a code task
needs a worktree to build/test the branch, but a config / live-surface task
needs a *running instance* to curl — and a non-worktree verifier agent
(`worktree: false`, with `exec`) isn't blocked by `coder-project-guard` on a
project that has no git path. So config tasks get functionally verified instead
of stalling on "project has no path".

`requireTags` is the scope knob: leave it unset to gate every `→ done`, or list
the tags your implementation tasks carry so plain assistant/PA tasks ("escalate
X", "log Y") still close themselves. The autopilot worker emits
`task.transitioned` on its force-finalize path, so the gate sees an
autopilot-completed task the same as an agent-driven `done`. Like the other
built-in guards it's a replaceable opinion — disable it and ship your own
subscriber to change the policy.

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

## Chat suggestion chips

The same pattern, applied to the Chat empty state. `packages/core/src/suggestions.ts` exposes `generateSuggestions(runtime)`, which reuses the briefing's `assembleBriefingContext` and runs **one** provider completion asking for `count` short imperative/question prompts, one per line. The response is parsed robustly — leading bullets (`-`/`*`/`•`), numbering (`1.`/`2)`), and wrapping quotes are stripped, blanks and lines over 100 chars are dropped, the list is de-duplicated and capped at `count`; if fewer than **2** usable lines survive it returns `[]` so the UI falls back to its plain empty state rather than rendering garbage. Off by default — no behavior or token cost unless enabled.

```yaml
suggestions:
  enabled: false        # master switch — when false /api/suggestions returns { enabled: false } with no provider call
  prompt: <generic default>   # system prompt; replaceable per install
  count: 4              # how many chips to ask for (hard-capped at 6)
  ttlMinutes: 15        # cache freshness window (shorter than briefing — chips track current state)
  model: ""             # optional model override against the active provider; omit to use the runtime default
```

Default prompt: *"You are the user's personal assistant. From the state below, write short prompts the user could send you right now to make progress. Output one prompt per line, each an imperative or a question under 60 characters. No numbering, no bullets, no quotes, no extra text. If nothing stands out, write generally useful prompts."*

`GET /api/suggestions` — `{ enabled: false }` when disabled (no provider call). When enabled, returns `{ enabled: true, suggestions, generatedAt }`: serves a fresh cached result within `ttlMinutes`, otherwise generates one (cached in process memory, single-flighted). TTL-only — there's no refresh endpoint. The web UI renders the suggestions as ghost-button chips above the Chat (and Chat dock) empty-state text, only when ≥2 are returned; clicking a chip sends it as a normal user message.
