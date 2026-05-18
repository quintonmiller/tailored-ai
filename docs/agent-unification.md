# Agent unification — design + rollout

Status: in progress (Phase 1 underway, 2026-05-17).

## Problem

Reviewing 48h of agent activity surfaced ~150 "tick: idle" notes polluting
semantic recall, 100% of delegations going to `email-fetcher`, 0 backlog
tasks advanced across 109 ticks, and recurring emails reported as "new
— recurring" indefinitely. Beneath the symptoms, six root causes —
collapsing into two themes:

| Theme | Root causes |
|---|---|
| Impoverished tick context | RC1 no action scoring · RC5 no outcome feedback · RC6 static goals |
| Channel confusion | RC2 telemetry pollutes memory · RC3 recall used as state-of-truth · RC4 LLM does dedup |

A seventh observation, raised separately: the system feels like *many*
disconnected agents (chat, ticks, delegates, workflows) rather than one
unified entity.

## Frame

Solving "make it feel like one agent" without forcing one long session.
Sessions stay short and isolated for context-budget reasons; **identity
is carried by a shared state layer** (`core_memory`) that every session
type reads at start and writes back to. The chat agent and tick agent
are the same agent because they wake up looking at the same core.

## Design

### Three-tier memory + telemetry + state

| Home | Purpose | Who writes |
|---|---|---|
| `core_memory` (NEW) | Stable identity, active threads, recent summary, open questions, user state | Agent only |
| `recall` (renamed `notes` later; same table) | Long-term memory, queryable by keyword + semantic | Agent only |
| `archival` (column on notes) | Promoted, durable subset of recall | Agent only |
| `tick_log` (NEW) | Operational telemetry (every tick writes here) | Worker (auto) |
| `email_seen` (NEW) | Dedup ledger so the LLM doesn't | Code |
| Domain tables (`project_tasks`, etc.) | Live state of the world | Tools |

### Two injection layers per session

Every session type (chat, tick, delegate, workflow) is built with:

- **`core_memory`** — read fresh from DB on every turn, system-reminder
  pattern so prior copies don't stack.
- **`live_state`** — computed fresh on every user turn (chat) or every
  tick (worker). Shape varies per session type. Same strip pattern.

### Tick context shape

```
TickContext {
  core_memory: { persona, active_threads, recent_summary, open_questions, user_state }
  signals: { new_emails, pending_asks, upcoming_calendar, user_chat_since_last_tick }
  backlog: { untouched, stale_in_review, user_touched }
  exploration_candidates: { untouched_areas, open_questions, stale_threads }
  outcomes_last_window: { ticks, tasks_moved, recall_written, delegations_by_specialist, stagnation }
}
```

Rendered into a "Situation" block with a typed candidate menu (A/B/C/D/E
+ `Sleep`). Exploration candidates are first-class — we explicitly do
NOT pre-filter ticks.

### Chat live_state shape

```
ChatLiveState {
  recent_ticks_6h: [{ at, summary }, ...]
  in_flight: { delegations, workflow_runs, in_progress_tasks }
  pending: { asks, top_backlog, due_workflows_today }
  last_user_touchpoint: { when, summary }
}
```

### Channel discipline rules

1. `recall` writes filtered against telemetry patterns (`/^tick:|standing by|no new material/i`).
2. State-claim notes deprecated. *"To know the current state of X, read X — don't recall it."*
3. Email dedup via `email_seen` table; `email-fetcher` excludes seen IDs at code level.
4. `tick_log` writes by worker, never by agent.

### Tick exit contract

A tick that does *material* work MUST update `core_memory.recent_summary`
(append one line, compact if > N lines) and/or `core_memory.active_threads`
(if a thread changed) before exiting. Noop ticks call `Sleep` and update
nothing. This is the load-bearing contract that makes the chat agent
aware of recent tick activity.

## Sequencing

| Phase | Focus | Effort |
|---|---|---|
| 1 | Channel separation + cleanup — new tables, sweep, tick_log writer, email_seen | 1–2 days |
| 2 | Core memory tool surface, cross-session injection, migrate goals.md | 1–2 days |
| 3 | Tick context + live_state, Sleep tool, 24h shakedown | 2–3 days |
| 4 | Polish — skip-on-busy lane rule, compaction tightening, doc updates | 1 day |

Each phase boundary is a clean stop. Phase 1 is mechanical + fully
additive; the agent's behavior doesn't change visibly until Phase 2.

## Confirmed decisions

- `core_memory` scope: per-(agent, project) with a global `persona` section that's project-invariant
- `archive_note` requires a `reason` string (one-liner)
- `Sleep` tool is tick-only initially (not exposed in reactive chat)

## Explicit non-goals

- Inline-session unification (rejected — context limits)
- Pre-filtering ticks (rejected — preserves exploration)
- `commitments` / `standing-orders` objects (covered by `active_threads`)
- Proactive push notifications (defer to post-Phase-3)
- Replacing the exploratory worker (same shape, richer inputs/outputs)

## References

- Investigation summary: agent IDs `afa2ee4adab978c38`, `a01d571b371ca2270` from 2026-05-17 session
- MemGPT/Letta three-tier model — [paper](https://arxiv.org/pdf/2310.08560), [Letta docs](https://docs.letta.com/concepts/letta/)
- openclaw heartbeat/commitments — [github.com/openclaw/openclaw](https://github.com/openclaw/openclaw)
- Reflexion outcome-feedback loop — [arXiv:2303.11366](https://arxiv.org/abs/2303.11366)
