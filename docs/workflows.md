# Workflows

Design doc for the workflow runner in `@tailored-ai/core`. Tracks epic
[autonomous-agent-jgev](../.beans/autonomous-agent-jgev--slice-5-workflow-system.md).

## Why workflows

`runAgentLoop` already runs one agent against one prompt. That covers
"have a model reach a goal," but it doesn't compose.

In practice we keep wanting:

- "Read this email, then run the researcher, then commit a summary."
- "On every PR webhook: clone the diff, run a reviewer, post comments,
  retry once if rate-limited."
- "Every Monday morning, fan out a digest task across N agents in
  parallel, then merge their outputs."

Each of those is a graph of agent runs and side effects with explicit
control flow, durable state, observable progress, and a clear error
policy. Open-coding them in cron jobs and tools doesn't scale —
output isn't durable, restarts re-run everything, and there's no UI
into what step is currently running.

A workflow is a **declarative, durable, restartable composition of
steps**. The agent loop becomes one of the step types.

### Non-goals

- Generic DAG executor (Temporal, Airflow). Workflows in TAI are
  _agent-shaped_: most steps are `agent_run` or `tool_call`. We get
  control flow for stitching, not for arbitrary BPM.
- Multi-host orchestration. A workflow runs in a single TAI process.
- Replacing cron / hooks / webhooks. Those become _triggers_ for
  workflows; the existing entry points keep working unchanged.

## Core concepts

| Concept | What it is | Where it lives |
| --- | --- | --- |
| **Workflow** | A YAML or TS-defined recipe with named steps. | `workflows/<name>.yaml` or `defineWorkflow({...})`. |
| **Run** | One execution of a workflow against a specific input. | Row in `workflow_runs`. |
| **Step** | One node in the workflow graph. | Row in `workflow_steps`, scoped to a run. |
| **Output** | The value a step produces. Threaded into later steps via `${steps.<name>}`. | Stored on the step row + on disk. |
| **Trigger** | The thing that starts a run. | Cron, HTTP, agent tool, webhook, programmatic. |

A run is **durable**: every step transition is persisted before the
step is invoked. If the process crashes mid-step, restart can resume
from the last successful step (where the step's own contract allows —
see "Restart semantics" below).

## Step types (v1)

Each step has a `name` (unique within the workflow) and a `type`. The
v1 set:

### `agent_run`

Run an agent loop. Most common step.

```yaml
- name: research
  type: agent_run
  agent: researcher
  prompt: "Summarize ${input.url}. Hand back the top 3 findings."
  maxToolRounds: 5            # optional override
  deadlineMs: 120000          # optional per-step deadline
```

Output: the agent's final response (the same string `runAgentLoop`
returns today).

Implementation: calls `runAgentLoop` with a fresh ephemeral session
keyed `workflow:<run-id>:<step-name>`. Sessions get the same hooks,
sandbox, and tool set the agent would have outside a workflow.

### `tool_call`

Invoke a single tool directly (no model in the loop). Useful for
side-effects that don't need an agent.

```yaml
- name: comment
  type: tool_call
  tool: tasks
  args:
    action: comment
    id: ${input.task_id}
    text: ${steps.research}
```

Output: the tool result's `output`. Failures (`success: false`) raise
unless caught by an `onError` policy.

### `shell`

Run a shell command via the active sandbox. Same security posture as
the `exec` tool.

```yaml
- name: build
  type: shell
  command: pnpm build
  cwd: ./packages/core         # optional
  env: { CI: "1" }             # optional
  timeoutMs: 60000
```

Output: stdout. Non-zero exit raises by default.

### `condition`

Branch on a JS-style boolean expression evaluated against the run's
variable scope.

```yaml
- name: should-deploy
  type: condition
  if: "${steps.tests.exitCode} == 0"
  then: [deploy]
  else: [notify-failure]
```

Output: `null`. Effect is to enable/disable downstream steps.

The expression language is **deliberately limited**: `==`, `!=`, `&&`,
`||`, `!`, parentheses, and `${...}` lookups. No method calls, no
arbitrary JS — that path is `eval` and we don't want it.

### `loop`

Repeat a sub-sequence over a list.

```yaml
- name: per-task
  type: loop
  over: ${input.tasks}        # must resolve to an array
  as: task                    # exposed as ${task} inside body
  body:
    - name: claim
      type: tool_call
      tool: tasks
      args: { action: update, id: "${task.id}", status: "in_progress" }
```

Output: array of body outputs (one per iteration).

Sequential by default. `parallel: true` runs iterations concurrently
(bounded by `maxConcurrency`, default 4).

### `parallel`

Run a group of named steps concurrently and join.

```yaml
- name: gather
  type: parallel
  steps:
    - name: fetch-issues
      type: tool_call
      tool: github
      args: { action: list }
    - name: fetch-emails
      type: tool_call
      tool: gmail
      args: { action: check }
```

Output: object `{ <name>: <output> }`. The whole step fails if any
child fails (unless the child has its own `onError`).

## Variable scope

Each step sees:

- `input` — the trigger payload (HTTP body, cron context, etc.).
- `steps.<name>` — outputs from prior siblings within the same
  enclosing list.
- `prev` — alias for the immediately preceding step's output.
- `env` — `process.env` (read-only).
- Inside a `loop` body: `<as>` — the current iteration item.
- Inside `parallel`: peers are **not** visible — references resolve
  only to outer-scope siblings, to avoid race-y reads.

Substitution:

- `${...}` inside a YAML string interpolates the result as a string.
- A YAML field whose entire value is a single `${...}` may resolve to
  any JSON value (preserves arrays/objects for `loop.over`).
- Same `expandPrompt` pipeline as today gets applied to all string
  values: `{{include:...}}`, `{{var}}`, and (gated) `` !`shell` ``.

## Error and deadline policies

Each step accepts:

```yaml
deadlineMs: 60000           # abort the step after this; counts as failure
onError: fail | continue | retry
retry:
  maxAttempts: 3
  backoffMs: 1000           # exponential, ×2 each attempt
```

Defaults: `onError: fail`, no retry, no per-step deadline. The
workflow-level `deadlineMs` (top-level field) caps the whole run.

`fail` (default): abort the run; remaining steps don't execute.
`continue`: log the error, set `steps.<name> = null`, move on.
`retry`: backoff-and-retry per the policy, then `fail` if exhausted.

Cleanup steps are out of scope for v1 — model them as `onError:
continue` followed by an explicit cleanup step.

## Restart semantics

When the TAI process restarts mid-run:

- The run row stays at `status: running`.
- A startup sweep promotes any `running` run with no live process
  back to `interrupted`.
- An interrupted run **does not auto-resume in v1** — surfaced in the
  UI with a "resume" button and via `POST /api/workflow-runs/:id/resume`.
- On resume: completed steps are not re-run. The next pending step
  starts fresh.
- Steps that were in flight at the time of crash are re-run from
  scratch. `agent_run` is therefore not idempotent — that's a known
  limitation; sandcastle has the same.

A future v2 might checkpoint inside an `agent_run` (per tool round)
but the cost/benefit isn't compelling yet.

## Triggers

| Trigger | Source | Note |
| --- | --- | --- |
| HTTP | `POST /api/workflows/:name/run` | Returns the run id; SSE on `/api/workflow-runs/:id/events`. |
| Cron | `cron.jobs[].workflow:` | Parallel to `agent:`. |
| Webhook | `webhooks.routes[].workflow:` | Parallel to `agent:`. |
| Agent tool | `run_workflow` tool | For nesting workflows from inside agents. |
| Programmatic | `runtime.runWorkflow(name, input)` | TS callers. |
| Tool call | `triggers: [{ kind: tool_called, tool: exec }]` | Fires after the tool ran. See below. |

The cron and webhook configs gain a `workflow:` field as a peer of
`agent:`. Existing configs keep working unchanged.

### `tool_called`

```yaml
triggers:
  - kind: tool_called
    tool: exec
```

The workflow receives `{ tool, args, output }` — the arguments the tool was
actually given, and the text the model saw come back.

It fires **after** the call completed, and only for calls that ran: a tool
refused by a `agent.pre_tool_use` subscriber, the skill allowlist, validation,
the approval gate or the derivability check never reaches it. So this counts
executions, not intentions. It cannot block a call — for that, subscribe to
`agent.pre_tool_use` directly ([architecture.md](./architecture.md#agentpre_tool_use-and-agentpost_tool_use)).

Fire-and-forget: the tool has already returned and the model is waiting on the
loop, so a workflow's failure is logged rather than surfaced into the turn, and
a slow workflow never delays a reply.

Delivered by `builtin:tool-called-trigger`, enabled by default. A deployment
that wants different behaviour disables it and subscribes its own handler.

> This trigger kind was declared, validated and listed in the UI long before
> anything dispatched it, so a config using it silently did nothing
> ([#561](https://github.com/quintonmiller/tailored-ai/issues/561)). It could
> not be fixed on its own: every other trigger kind has a poller, and this one
> needed a tool-level event on the bus, which did not exist.

## Storage

Two new tables, mirrored on the existing SQLite store:

```sql
CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,                -- "wfrun_<uuid8>"
  workflow_name TEXT NOT NULL,
  status TEXT NOT NULL,               -- pending|running|completed|failed|interrupted|cancelled
  trigger TEXT NOT NULL,              -- http|cron|webhook|tool|programmatic
  input_json TEXT NOT NULL,
  output_json TEXT,                   -- final output if completed
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  generation INTEGER NOT NULL         -- runtime.generation at start
);

CREATE TABLE workflow_steps (
  id TEXT PRIMARY KEY,                -- "wfstep_<uuid8>"
  run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  step_name TEXT NOT NULL,
  step_type TEXT NOT NULL,
  status TEXT NOT NULL,               -- pending|running|completed|failed|skipped
  attempt INTEGER NOT NULL DEFAULT 1,
  output_json TEXT,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  parent_step_id TEXT REFERENCES workflow_steps(id)  -- for loop/parallel children
);

CREATE INDEX idx_workflow_steps_run ON workflow_steps(run_id);
CREATE INDEX idx_workflow_runs_status ON workflow_runs(status);
```

Per-step logs (stdout/stderr from `shell`, full agent transcripts from
`agent_run`) live on disk under
`data/workflow-runs/<run-id>/<step-name>.log` to keep the DB compact.

## Hot reload

Workflows go through `runtime.reload()` like everything else:

- `runtime.getWorkflows()` returns the current workflow registry.
- `fs.watch` on `workflows/` debounced 500ms triggers reload.
- In-flight runs keep their original definition (their `generation`
  column is captured at start). Only new runs see the updated YAML.

## Programmatic API

For TS consumers:

```ts
import { defineWorkflow } from "@tailored-ai/core";

export const reviewPR = defineWorkflow({
  name: "review-pr",
  steps: [
    { name: "fetch", type: "tool_call", tool: "github", args: { action: "diff" } },
    { name: "review", type: "agent_run", agent: "reviewer", prompt: "${steps.fetch}" },
    { name: "comment", type: "tool_call", tool: "github", args: { action: "comment", body: "${steps.review}" } },
  ],
});

// Register and run:
runtime.registerWorkflow(reviewPR);
const result = await runtime.runWorkflow("review-pr", { pr: 42 });
```

`defineWorkflow` is a typed identity function — same shape as the
YAML, just typed.

## Custom step executors

The built-in step types (`agent_run`, `shell`, `tool_call`, etc.) are
registered as factories in `StepExecutorRegistry` at startup. Plugins
and library consumers can add their own step types through the same path.

### From a plugin

```ts
import type { Plugin } from "@tailored-ai/core";

export default ((ctx) => {
  ctx.stepExecutors.register("send_email", (execCtx) => ({
    type: "send_email",
    async execute(step, _ctx) {
      // step is typed as WorkflowStepDef; cast to your own type
      const s = step as { to: string; subject: string; body: string };
      await sendEmail({ to: s.to, subject: s.subject, body: s.body });
      return { output: "sent" };
    },
  }));
}) satisfies Plugin;
```

Register before `createWorkflowEngine` runs (plugin functions run during
CLI startup, before the engine is created). Then add steps of that type
in workflow YAML:

```yaml
- name: notify
  type: send_email
  to: quint@example.com
  subject: "Run ${input.name} finished"
  body: "${steps.prior_step}"
```

The factory receives a `StepExecutorContext` with `runtime`, `db`,
`resolveOutbound`, `getOwnerId`, and optional email plumbing — use only
what you need.

### Overriding a built-in

Register for the same `type` string. The last-registered factory wins,
so a plugin can swap out any built-in executor without patching core.

### From library code (no plugin loader)

```ts
import { populateBuiltinExecutors } from "@tailored-ai/core";

runtime.getStepExecutorRegistry().registerFactory("my_step", (ctx) =>
  new MyStepExecutor({ db: ctx.db }),
);
// Then call createWorkflowEngine — it picks up the factory automatically.
const engine = createWorkflowEngine({ runtime, db: runtime.db });
```

### FormExecutor

`FormExecutor` is constructed after the engine because it needs
`engine.forms` (the FormRegistry). This is an implementation detail of
the built-in; custom executors that don't have a circular dependency
should use the factory path above.

## Autopilot integration (opt-in)

`AutopilotWorker` keeps its existing per-task `runAgentLoop` path as
the default. When a task carries a `workflow:<name>` tag and the named
workflow exists, the worker invokes it instead, with `input = { task,
agent }`. This keeps the existing autopilot working and lets users
dial in workflows incrementally.

## Resolved decisions

1. **Cancellation** — wait with grace period. Cancel sets a flag the
   engine checks between steps and (for `agent_run`) between tool
   rounds. `shell` steps get a 30s grace window after SIGTERM before
   SIGKILL. `agent_run` is a no-op cancel until the loop's next
   iteration boundary; we do not interrupt in-flight provider calls.
2. **Concurrency limits** — both global and per-agent caps are
   configurable. Defaults:
   ```yaml
   workflows:
     maxConcurrent: 4              # global cap on concurrent runs
     maxConcurrentByAgent:
       researcher: 2               # cap on concurrent agent_run steps
       coder: 1                    # by agent name; overrides default
       _default: 2                 # default for any agent not listed
   ```
   The engine holds two semaphores: a workflow-level run gate
   acquired when a run leaves `pending`, and a per-agent gate
   acquired on entry to each `agent_run` step (released on the step's
   `finally`). Steps blocked on the agent gate stay in `pending`
   status with a `blocked_on: agent:<name>` annotation so the UI can
   surface the queue.
3. **Secrets** — `${ENV_VAR}` interpolation via `deepInterpolate` (the
   same path `config.yaml` already uses). No new mechanism.
4. **Logs retention** — keep the last 100 runs per workflow on disk;
   older runs purge log files but keep DB rows.
5. **UI scope** — S5 ships the HTTP API and SSE only; the UI editor
   and run viewer are deferred to S6 (`autonomous-agent-38od`).

## Decomposition

S5 splits into the sub-beans listed under
`autonomous-agent-jgev` (one bean per slice). The recommended order:

1. S5.1 — DB schema + run/step models
2. S5.2 — Workflow loader (YAML + validate + hot reload)
3. S5.3 — Engine core: sequential execution, variable threading, deadlines
4. S5.4 — Step types: `agent_run`, `tool_call`
5. S5.5 — Step types: `shell`, `condition`
6. S5.6 — Step types: `loop`, `parallel`
7. S5.7 — HTTP triggers: `POST /api/workflows/:name/run` + SSE
8. S5.8 — Cron + webhook triggers: `workflow:` field
9. S5.9 — Programmatic `defineWorkflow` + `run_workflow` agent tool
10. S5.10 — Autopilot integration (opt-in per task tag)
11. S5.11 — Per-step logs to disk + retention
12. S5.12 — Test coverage across step types and trigger paths

Slices 1–4 are the critical path: after them you can already run a
linear `agent_run`-only workflow from HTTP. Everything else is an
incremental add.
