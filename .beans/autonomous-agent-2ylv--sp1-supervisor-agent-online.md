---
# autonomous-agent-2ylv
title: SP1 — Promote `default` agent into the supervisor role
status: completed
type: task
priority: high
created_at: 2026-05-14T19:36:04Z
updated_at: 2026-05-14T20:05:00Z
parent: autonomous-agent-17dl
---

# SP1 — Promote `default` agent into the supervisor role

Update the existing `default` agent (already named "CORAL" in its
identity files) to take on supervisor duties — reactive in chat AND
online with a tick cadence, delegating focused work to specialists.
Keep one agent identity rather than adding a separate `supervisor`
agent; user has a strong preference for one primary assistant they
chat with that knows what its sub-agents are doing.

Includes a small engine change: budgets become opt-in (missing
`online.budgets` block → no enforcement, instead of falling back to
8000-token / 8-tool-call / 12-runs-per-day defaults). The user is on
local models and explicitly does not want budgets right now.

## Changes

### `packages/core/src/exploratory/worker.ts`

- Remove `DEFAULT_TOKENS_PER_TICK`, `DEFAULT_TOOL_CALLS_PER_TICK`,
  `DEFAULT_RUNS_PER_DAY_CAP` constants.
- `tokens_per_tick` missing → `Number.POSITIVE_INFINITY` (no enforcement).
- `tool_calls_per_tick` missing → fall back to the agent's reactive
  `maxToolRounds` (from `baseOpts`), keeping online + chat symmetric.
- `stop_after_runs_per_day` missing → `Number.POSITIVE_INFINITY`.
- Tests that exercise budgets all set explicit values, so they still pass.

### `~/.tailored-ai/config.yaml`

- Update `agents.default` in place (do **not** add a new `supervisor`
  agent):
  - `description`: "Primary assistant. Reactive in chat; online with a
    cadence so it can advance my goals between conversations. Delegates
    focused work to specialist agents."
  - `instructions`: orchestration-flavoured. Teach the five "send work
    off" verbs (sync `delegate`, async `delegate`, `tasks(create,
    assignee)`, `run_workflow`, `ask_user`) and when to pick which.
    Include a list of currently-available specialists and what each is
    for (initially just `email-fetcher`). Add the rule: "during chat,
    prefer answering + proposing; do not initiate heavy work unless I
    ask. During online ticks, advance whichever goal is most useful
    right now."
  - `tools`: `delegate, run_workflow, tasks, task_query, projects,
    documents, facts, recall, memory, ask_user, gmail, web_search,
    web_fetch, read`.
  - `temperature: 0.4`, `maxToolRounds: 20`, `injectMemory: true`,
    `summarizeOnTrim: true`.
  - `online`:
    - `enabled: true`
    - `cadence.interval_minutes: 15` (start aggressive; will back off on
      no-ops)
    - `cadence.idle_backoff_multiplier: 2`
    - `cadence.max_interval_minutes: 120`
    - `cadence.window`: 08:00 – 22:00
    - `budgets`: **omitted** — engine change above makes this "no
      enforcement", which is what the user wants for now.
    - `goals_file: goals.md`
    - `output.notify_owner_on_finding: false` (rare/important only;
      defer until we know what's worth pinging on)
    - `tools`: same allowlist as the agent (do not narrow further until
      we see what online ticks actually do).

### `data/context/agents/default/goals.md` (overwrite)

The existing file (left over from previous online ticks) is replaced
with the new duty list. The agent's accumulated `identity.md`,
`observation_*.md`, and `session_notes.md` files are left in place —
those are part of the agent's continuity.

```markdown
# Supervisor goals

Reactive (when the user is chatting):
- Answer directly. Cite recall when a sub-agent recently learned the
  relevant thing. Propose actions; do not initiate heavy work unless
  asked.

Online (background ticks):
- Every ~30 min during working hours, delegate to email-fetcher to
  check the inbox. If anything material surfaces, run the
  email-triage workflow.
- Skim recall + facts for stale or contradictory entries; fix or flag.
- If autopilot has a stuck task (in_review > 24h with no comment),
  surface it via a recall note.

Hygiene:
- When delegating, write a one-line recall note summarising what the
  specialist reported. This keeps reactive turns + future ticks aware
  of recent activity without re-asking.
- Before delegating to a specialist, recall-check whether the same
  specialist already answered this question recently. If so, use that
  answer rather than re-firing.
```

## Acceptance

- `pnpm run dev` starts cleanly; the `default` agent description now
  reads as the primary assistant.
- The online worker logs a tick for `default` within the cadence
  window; `exploratory_runs` has a row.
- Chatting `pnpm run dev -- -m "what have you been doing?"` returns a
  reasonable answer that references recent recall.
- No new `supervisor` agent exists; we kept one agent identity.
- `pnpm run typecheck` + `pnpm run test` pass (914/914).

## Out of scope

- Any new tools — supervisor uses what's already registered.
- Any engine changes — depth cap, inbox, etc. live in their own beans.
- Per-project supervisor overlays — defer until we have one in
  practice.
