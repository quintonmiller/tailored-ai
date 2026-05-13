# Always-On / Exploratory Agents — Design

Status: **design only**, not yet implemented. Tracking task: `ptask_always_on_agents`.
Depends on `ptask_memory_tiers` ([design](./memory-tiers.md)). Do not start implementation
until the memory tiers slice plan is past M3 (loop injection + short-term notes).

## Why

Today every agent execution falls into one of two modes:

1. **Reactive.** A user/channel/webhook sends a message → loop runs → loop ends.
2. **Scheduled task claim.** Autopilot ticks every 30s, claims one backlog task,
   runs it, marks done/blocked. Cron jobs work similarly but on a fixed schedule
   with a fixed prompt.

Both are externally-triggered. There is no mode in which an agent says
"nothing was asked of me, but I'll spend 5 minutes seeing if anything's
worth flagging." A lot of useful work fits that shape:

- **Opportunistic research.** Skim HN / a feed / a Slack channel and note
  anything matching a goal.
- **Codebase observation.** Look for refactor candidates, drifting docs,
  outdated dependencies.
- **Anomaly detection.** Check logs / metrics / unread email for things
  the user might miss.
- **Goal refinement.** Re-read its own goals.md and recurring notes,
  surface contradictions or stale items.

None of these need a task in the queue. They need a *cadence* and a
*goal*.

## What it is

A new worker type — `ExploratoryWorker` — that runs alongside
`AutopilotWorker`. Per agent, the user toggles "online" mode on and
configures:

- **Cadence.** "Every 30 minutes during 9am–6pm" or "every 4 hours always."
- **Goals.** Free-form text in the agent's `goals.md`, or pointers into
  the project KB.
- **Allowed actions.** Subset of the agent's tool list. Bias toward read
  / observe; write actions opt-in.
- **Budgets.** Per-tick and per-day token caps, tool-call caps.
- **Output policy.** Where exploratory findings go: notes (default),
  facts (when high-confidence), backlog tasks (when actionable), Discord
  DM (rare, important things only).

A "tick" looks like:

```
1. Worker wakes (cadence elapsed, not in quiet hours, under budget).
2. Recall: read recent notes from this agent + project (via `recall`,
   from the memory tiers design). Skip if budget exhausted.
3. Build a tick prompt: agent's goals + summary of recent notes +
   "what should I look at next?"
4. Run the agent loop with a tick-scoped AbortController + budget.
5. Output: agent writes findings via `recall note`, `facts set`,
   `tasks create`, or `notify_owner`.
6. Record the tick in `exploratory_runs` with status + token usage.
```

Crucially: **the worker does not pick the goal**. The agent does. The
worker only schedules ticks and enforces budgets. The agent reads its
own `goals.md` (a long-term memory artifact) and decides what to do.
This keeps the worker stupid and the agent capable.

## Difference vs autopilot vs cron

| Property             | Cron job          | Autopilot                   | Exploratory                       |
|----------------------|-------------------|-----------------------------|------------------------------------|
| Trigger              | Schedule          | Task in backlog             | Cadence (idle worker)              |
| Input                | Fixed prompt      | Task title + body           | Recall-built prompt                |
| Output               | Discord / log     | Task status + comments      | Notes (mostly), facts, backlog     |
| Per-run budget       | Inherits agent    | Inherits autopilot          | Per-agent override + autopilot cap |
| Persistence          | Session per run   | Per-task session            | Per-agent rolling session          |
| Stops when           | Job removed       | Task done/blocked           | Toggle off, budget out, stop-cond  |

Exploratory mode is the only one that's "always-on" — the others are
event-shaped.

## Configuration

Per-agent in `config.yaml`:

```yaml
agents:
  watcher:
    instructions: "You are a research / observation assistant."
    tools: ["recall", "web_search", "web_fetch", "facts", "tasks"]
    online:
      enabled: true
      cadence:
        interval_minutes: 30          # base interval
        idle_backoff_multiplier: 2.0  # interval *= multiplier when last tick was a no-op
        max_interval_minutes: 240     # cap on backoff
        window:                       # only fire inside this window
          start: "09:00"
          end:   "18:00"
      goals_file: "goals.md"          # relative to agent context dir
      budgets:
        tokens_per_tick: 8000
        tokens_per_day: 80000
        tool_calls_per_tick: 8
        stop_after_runs_per_day: 12
      output:
        notes: true
        facts: true
        tasks: true
        notify_owner: false           # off by default; only for high-importance
      tools:                          # optional narrower tool subset for online ticks
        - recall
        - web_search
        - web_fetch
        - facts
```

A single new top-level section gates the worker itself (mirrors
`autopilot:`):

```yaml
exploratory:
  enabled: true
  baseIntervalMs: 60000              # how often the worker checks for due agents
```

### Settings stored in DB (mirrors `autopilot_settings`)

Per-agent runtime overrides editable via UI:

```sql
CREATE TABLE exploratory_state (
  agent_name        TEXT PRIMARY KEY,
  enabled           INTEGER NOT NULL DEFAULT 1,
  paused_until      TEXT,
  last_tick_at      TEXT,
  last_tick_status  TEXT,            -- "ok" | "noop" | "budget" | "error"
  current_interval_ms INTEGER,        -- after backoff
  tokens_today      INTEGER NOT NULL DEFAULT 0,
  tokens_today_resets_at TEXT,
  runs_today        INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE exploratory_runs (
  id              TEXT PRIMARY KEY,   -- xrun_<uuid8>
  agent_name      TEXT NOT NULL,
  project_id      TEXT,
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at        TEXT,
  status          TEXT NOT NULL,      -- "running" | "ok" | "noop" | "budget" | "error"
  tokens_used     INTEGER,
  tool_calls      INTEGER,
  note_ids        TEXT NOT NULL DEFAULT '[]',  -- JSON array of recall note IDs created
  fact_ids        TEXT NOT NULL DEFAULT '[]',
  task_ids        TEXT NOT NULL DEFAULT '[]',
  notified_owner  INTEGER NOT NULL DEFAULT 0,
  summary         TEXT,                -- short text the agent generated
  error           TEXT
);
CREATE INDEX idx_xruns_agent_started ON exploratory_runs(agent_name, started_at);
CREATE INDEX idx_xruns_project_started ON exploratory_runs(project_id, started_at);
```

## Worker architecture (`packages/core/src/exploratory/worker.ts`)

Parallel to `AutopilotWorker`, sharing as much as possible.

```ts
export class ExploratoryWorker {
  start(): void                              // setInterval at baseIntervalMs
  stop(): void
  async tick(): Promise<void>                // scans agents, runs due ones
  private async runAgent(name, def): Promise<void>
  getActivity(): { agent: string; runId: string } | undefined
}
```

Pseudo-code of `tick()`:

```
for each agent with online.enabled:
  state = loadState(agent)
  if state.paused_until > now: skip
  if outside config window: skip
  if budget exhausted (tokens_today >= cap or runs_today >= cap): skip
  if (now - state.last_tick_at) < state.current_interval_ms: skip

  runAgent(agent, def)
```

`runAgent()`:

```
1. Build a fresh session keyed `exploratory:<agent>:<runId>`.
2. Read goals via recall tool (or fall back to context file).
3. Build tick prompt:
   "[Goals]\n{goals}\n[Recent notes]\n{recall result}\nPick the most
    useful single thing to do this tick toward those goals. If nothing
    new is worth doing, write a note saying so and stop."
4. AbortController with budget enforcement (token meter wraps provider).
5. Run loop with the narrowed online.tools list, tool-call cap, etc.
6. Inspect outputs:
   - If agent wrote >=1 note → status=ok
   - If agent's response is just "no new observations" → status=noop
     → increase interval (backoff)
   - If error → status=error, record, notify if importance high
7. Record exploratory_runs row, update state, reset interval if not noop.
```

### Budgets

A `BudgetGuard` wrapping the provider:

```ts
class BudgetGuard implements AIProvider {
  constructor(inner: AIProvider, perTick: number, perDay: AtomicCounter) {}
  async chat(...) {
    if (this.tokensUsedThisTick + estimate >= this.perTick) abort();
    const result = await this.inner.chat(...);
    this.tokensUsedThisTick += result.usage;
    this.perDay.add(result.usage);
    return result;
  }
}
```

The day counter is shared with autopilot — exploratory work doesn't get
to blow the daily token budget on its own. Configurable in
`autopilot_settings.token_cap_24h` (already exists).

### Idle backoff

If a tick produces a no-op (agent says "nothing to look at"), the next
interval doubles, capped at `max_interval_minutes`. A successful tick
resets to base interval. This stops a chatty watcher from burning
tokens during truly idle periods.

## Output channels

Exploratory ticks have four output surfaces, all of which already exist
or are covered by the memory tiers design:

| Channel        | When                                              | Implementation  |
|----------------|---------------------------------------------------|------------------|
| **Notes**      | Default. Most observations.                       | `recall note`    |
| **Facts**      | High-confidence atoms (price changed, ETA, etc.)  | `facts set`      |
| **Backlog**    | Actionable items.                                 | `tasks create`   |
| **Notify owner** | High-importance only, gated by quiet hours.     | autopilot's `notifyNeedsHuman` helper |

The agent's `output.notify_owner: false` default means the user is
*never* DM'd by exploratory work unless they explicitly opt in. This is
the difference between "useful background worker" and "annoying."

## Goals: how the agent knows what to look at

Three layers, all already supported by the memory tiers design:

1. **`goals.md`** in agent context dir — pinned via context file injection.
2. **High-importance notes** with tag `goal:*` — surfaced via recall in
   the tick prompt.
3. **Recent activity** — the recall result includes its own recent
   exploratory notes, so the agent maintains a thread of thought
   across ticks.

Example `goals.md`:

```markdown
# Watcher goals

- Skim HN front page once / hour during work hours; flag anything tagged
  `ai-agents` `local-llm` or `react`.
- Watch packages/core for new TODO comments and surface them as backlog.
- Once a week, summarize all notes I've written and propose what to
  promote to long-term memory.
```

The agent re-reads this on each tick (or it's recall-injected) and uses
it as the source of truth for what to do.

## Safety

This is the riskiest mode in the system — an agent doing things nobody
asked for. Safeguards:

1. **Off by default** at every level. Top-level `exploratory.enabled`,
   per-agent `online.enabled`, both default false.
2. **Tool allowlist.** `online.tools` (if set) narrows to a *strict*
   subset; defaults to recall + read-only tools if unset. Write tools
   (`exec`, `write`, `tasks create` to a remote backend like GitHub)
   are opt-in.
3. **Sandbox inheritance.** Exploratory ticks run under the same sandbox
   as the rest of the agent's work (host / docker / podman). No new
   capability surface.
4. **Token + run caps.** Per-tick, per-day. Daily cap shared with
   autopilot so exploratory + task work share a budget rather than
   stacking.
5. **Quiet hours.** Inherited from `autopilot_settings.quiet_start/end`
   for `notify_owner` calls. Worker can still tick during quiet hours
   but cannot DM.
6. **Pause from UI.** Single button on the dashboard pauses all
   exploratory work for N hours.
7. **No external triggers.** Exploratory ticks cannot start workflows
   that call out to LLMs other than the agent's own. (Workflow
   dispatch is on the `online.tools` allowlist so the user can disable
   it explicitly.)

## UI surface

On the existing dashboard (now revamped in `ptask_ux_dashboard_revamp`):

- The "Now" strip already shows the currently-active autopilot task;
  extend it to show exploratory ticks in progress.
- New panel "Watchers" under "Now": one row per online agent showing
  state (`running` / `idle, next at HH:MM` / `paused` / `budget`),
  tokens today, runs today, last tick status, and a Pause / Resume
  button.
- Recent exploratory output goes into the existing "Recent" panel as
  note rows ("watcher · 3 new observations").
- A drill-down route `#/exploratory/<runId>` shows the full tick:
  prompt, tool calls, output notes / facts / tasks created.

## Slice plan (implementation order, for later filing)

Filed after memory tiers M3 lands.

1. **A1 — schema + settings**
   - `exploratory_state` + `exploratory_runs` tables.
   - Config types in `AgentConfig.agents.<name>.online` + top-level
     `exploratory`.
   - DB queries.
   - Validation: warn if `online.enabled` is set on an agent that
     doesn't have `recall` in its tools.

2. **A2 — worker shell, no agent loop yet**
   - `ExploratoryWorker` class with `start/stop/tick`.
   - Scans config, respects cadence + windows + paused state.
   - Logs "would run agent X" without running anything.

3. **A3 — agent loop integration**
   - Build tick prompt from goals + recall.
   - Run loop with narrowed tools, BudgetGuard, AbortController.
   - Record run row.

4. **A4 — outputs + idle backoff**
   - Detect note/fact/task creations from the run.
   - Backoff on no-op.
   - Reset interval on activity.

5. **A5 — UI + notifications**
   - Dashboard "Watchers" panel.
   - Pause/resume buttons + REST endpoints.
   - Drill-down run view.

6. **A6 — goal refinement helper (optional, can defer)**
   - A built-in skill the agent can invoke once a week to re-read all
     its notes and propose updates to its own goals.md.
   - Sets up a self-improving loop without touching the worker itself.

## Risks

- **Cost runaway.** A misconfigured cadence with no budget can burn
  tokens fast. Mitigations: defaults bias conservative (60min cadence,
  modest daily cap); UI surfaces "tokens today" prominently.
- **Notification fatigue.** If `notify_owner` is enabled the user gets
  pinged. Default it off; require explicit per-agent opt-in.
- **Tools doing damage.** Same write-tool surface as a normal session;
  exploratory mode just calls them autonomously. Mitigation: default
  tool allowlist is read-only; user must opt in to writes.
- **Stale loop.** If the agent's goals are empty or unclear, ticks
  produce no-ops and backoff caps out. Worst case: wasted tokens
  during the backoff ramp. UI signals "agent X has been backed-off
  to max interval — review goals."
- **Memory pollution.** Lots of exploratory notes could drown out
  user-authored ones in recall. Mitigation: notes carry an
  `agent` field; recall lets the caller filter by author; promotion
  rules require references from a *different* agent (or the user)
  before exploratory notes graduate.
- **Single-tenant scope.** S7 projects are still single-active; an
  exploratory worker today can only operate against the runtime's
  active project. Multi-project parallel exploration is a future bean,
  consistent with the autopilot constraint.

## What this enables next

Closes the gap between "agent runs when asked" and "agent that learns and
self-directs." Specific futures unblocked once this and memory tiers
ship:

- **Cross-agent observation.** A watcher agent files backlog tasks; an
  autopilot agent picks them up. Closed loop without human routing.
- **Per-project assistants.** A project's `.tai.yaml` overlays an online
  agent specialized to that codebase.
- **Goal refinement.** Agent re-reading its own notes and proposing
  changes — first step toward genuinely adaptive behavior.

Stop conditions for "is this design done" before implementation:
budgets are clear, defaults are safe, the worker is dumb (no goal logic
in the worker — all of that is in the agent's prompt + memory).
