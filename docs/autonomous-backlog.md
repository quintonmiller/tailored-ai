# Autonomous Backlog — UX Design

Design doc capturing the agreed-upon user experience for the agent continuously
working through a project's backlog. Implementation plan lives at the bottom.

## Mental model

The agent is a teammate on the project board. It picks up cards assigned to it,
in the order you've ranked them. It asks when confused, flags when blocked,
closes cards when done. The Kanban board is the interface — there is no separate
"agent dashboard."

## Core concepts

### Tasks
- Each task has an **assignee** field. Defaults to the project's default
  agent. Reassignable to the user, the managing agent, or (in future) to a
  specific sub-agent.
- Each task has a **rank** field. Rank 1 = top of backlog. New tasks receive
  `max(rank) + 1` at creation. Reordering in the UI mutates rank.
- The agent's work queue is trivially defined as:
  > *tasks where `assignee = me` AND `status = 'backlog'`, ordered by `rank` ASC*

No priority tiers, no hidden scheduler logic. The user ranks cards by dragging;
the agent takes the top-ranked one.

### Status flow for agent-assigned cards

```
backlog → in_progress → { done | blocked(question) | blocked(budget) }
                         ↑             │                    │
                         │   you answer │    window rolls   │
                         └─────────────┴────────────────────┘
```

- The agent self-transitions `backlog → in_progress` when it picks a card up.
- On completion, agent self-transitions to `done`. For tasks where the agent
  genuinely isn't sure of the outcome, it may instead self-transition to
  `in_review` (agent-initiated review gate).
- `blocked(question)` — agent needs human input. Surfaces the question at the
  top of the card with an inline reply box. User's reply flips card back to
  `in_progress`; agent resumes on next tick.
- `blocked(budget)` — token cap hit mid-task. Card shows countdown to window
  roll. Auto-unblocks when the window resets; no manual action needed.

The two blocked variants are visually distinct so users can see at a glance
whether the ball is in their court.

## Settings — user level

Single "Autopilot" settings panel under **Config → Autopilot**. Applies across all projects.

- **Token caps** — rolling windows: 1h / 5h / 24h. Current usage meters shown
  alongside.
- **Quiet hours** — agent works, but notifications are silenced until the
  window ends.
- **Disabled hours** — agent does no work at all.
- **Emergency pause** — one toggle.
- **Budget-hit behavior** — hard stop at the next LLM-round boundary. Card
  moves to `blocked(budget)`. Auto-resumes on window roll.

These are user-level because they represent real constraints (money, time)
that span projects.

## Settings — project level

Lives on the existing Projects page.

- **Default assignee** — which agent manages this board. New tasks default to
  this assignee.
- Project-specific instructions / context (future — leverages existing
  per-agent context directory pattern).

## Conversations and autopilot

- Single agent identity, multiple parallel conversations.
- Autopilot runs as its own "conversation"; chats are separate conversations.
- Transcripts do not cross between conversations.
- **Memory is the shared substrate** — what the agent learns in one context
  is available in others (uses the existing `memory` tool).
- A persistent "Agent working on: [card title]" strip is visible during chats
  so background activity is never invisible.

## Notifications

- **Real-time only for needs-human events** — `blocked(question)`,
  unrecoverable errors.
- **Morning digest** — "Overnight: 3 done, 1 blocked on you, 2 budget-deferred."
- **Never** — per-completion pings. The board already shows that.

## Guardrails

- Destructive actions rely on the existing tool-approval model. No separate
  dry-run layer.
- Runaway loops are capped by existing `maxToolRounds`. On cap hit, card →
  `blocked` with the reason recorded as a comment.

## Concurrency

One worker to start. If the user reassigns a card mid-work, the agent finishes
its current LLM-round boundary, then checks reassignment before starting the
next round and yields if the card is no longer theirs.

## Out of scope (for now)

- Multiple parallel workers
- Tag-based routing to different sub-agents
- Dependencies between tasks
- Dry-run / preview mode beyond the existing tool-approval model

---

## Implementation plan (phased)

Each phase lands independently and leaves the system in a working state.

### Phase 1 — Data model foundation

- `project_tasks`: add `assignee TEXT`, `rank INTEGER NOT NULL`,
  `blocked_reason TEXT` columns. Migration backfills `rank` from `created_at`
  order per project and `assignee` from the project's default.
- `projects`: add `default_assignee TEXT` column.
- `TasksTool`, `TaskQueryTool`, `task-queries.ts`, REST API: expose the new
  fields. Tools accept aliases (`rank`/`order`, `assignee`/`owner`).

### Phase 2 — Autopilot settings + usage tracking

- `autopilot_settings` table (singleton row) — token caps, quiet hours,
  disabled hours, paused flag.
- `token_usage` table — one row per agent turn with timestamps + token counts
  (prompt, completion). Used for rolling-window queries.
- Budget-check helper — given timestamp windows, returns current usage and
  whether any cap is exceeded.

### Phase 3 — Autopilot worker loop

- New worker service (cron-driven on short interval, e.g. every 30s).
- Per project: if in disabled hours → skip. If budget cap hit → skip and
  defer. Otherwise pick the top agent-assigned backlog card, run the agent,
  transition on result.
- `ask_user` tool integration: when called inside autopilot, route answer to
  task comment and set `blocked(question)`.
- On window roll, unblock `blocked(budget)` cards.

### Phase 4 — Notifications + digest

- Realtime Discord DM for `blocked(question)` and unrecoverable errors
  (respects quiet hours — queued until quiet ends).
- Morning digest job summarizing overnight activity.

### Phase 5 — UI

- Kanban `Tasks` page: assignee dropdown on cards, rank ordering within
  backlog, drag-to-reorder, distinct blocked-reason rendering, inline reply
  box for `blocked(question)`.
- `Projects` page: default assignee setting, plus an autopilot status pill
  and an onboarding hint when the project has no assignee set.
- `Config → Autopilot` section: token caps, hours, pause toggle, live usage
  meters, "Run digest now" button.
- Persistent "Agent working on: X" strip (global).

### Phase 6 — Agent behavior polish

- `in_review` self-selection when agent uncertainty is high.
- Autopilot-specific system prompt additions that reference the task metaphor.
- Dogfooding pass.
