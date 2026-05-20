---
# autonomous-agent-17dl
title: Supervisor / specialist agent orchestration
status: in-progress
type: epic
priority: high
created_at: 2026-05-14T19:36:04Z
updated_at: 2026-05-14T19:36:04Z
---

# Supervisor / specialist agent orchestration

Make the primary agent the *one I chat with* AND the *one that runs online*.
It delegates focused work to single-purpose specialist agents and pulls
their findings into a shared cortex (recall + facts + memory) so reactive
chat and background ticks see the same state.

## Why

The current model splits work into independent agents (cron jobs,
exploratory ticks, the email-triage workflow). When I chat with one
agent, it doesn't know what the others have been doing without explicit
prompting. The supervisor pattern centralises orchestration on the agent
I'm already talking to:

- I keep one mental model (one assistant) but it has helpers.
- Specialists stay small and focused — each does one thing well.
- Recall + facts already function as shared memory across agents; this
  just leans on them deliberately.
- The existing online worker handles cadence, idle backoff, and
  goal-driven action selection. We don't need new infra for ticks.
- Workflows (e.g. `email-triage`) become tools the supervisor *invokes*,
  not background jobs that run independently of it.

## Shape

- **`default`** agent (the existing primary agent — already named
  "CORAL" in its identity files) takes on the supervisor role.
  `online.enabled: true`, no budgets. Toolbelt is orchestration-heavy
  (`delegate`, `run_workflow`, `tasks`, `recall`, `memory`, `facts`,
  `ask_user`) plus the read tools it needs to sanity-check work. Goals
  live in `data/context/agents/default/goals.md`. We do **not** add a
  separate `supervisor` agent — keep one agent identity, evolve its
  role.
- **Specialists** — none online, none scheduled. They only exist to be
  delegated to. Each has a narrow tool allowlist matching its role.
  First specialist: `email-fetcher` (read-only inbox triage).
- **Shared cortex** — every sub-agent writes recall notes + facts when
  it learns something durable; the primary agent reads those on
  subsequent ticks/turns via `injectMemory`.

## Slices

| Slice | Bean | Status |
| --- | --- | --- |
| SP1 | Supervisor agent + duty list | active |
| SP2 | `email-fetcher` specialist + supervisor delegates to it | active |
| SP3 | `delegate` depth cap | deferred |
| SP4 | `agent_messages` inbox + async delegate with `reply_to` | deferred |
| SP5 | Additional specialists (project-updater, fact-recorder, task-curator) | deferred |

SP1 + SP2 are the prioritised path. They are pure config (agent
definitions, `goals.md`, instructions) — no engine changes — so they
can land independently. SP3/SP4/SP5 unlock richer patterns later but
do not block the supervisor going online.

## Resolved decisions

1. **Budgets** — opt-in only. When `online.budgets` is omitted, no cap
   is enforced (token cap = Infinity, runs/day cap = Infinity,
   tool-call cap falls back to the agent's reactive `maxToolRounds`).
   Set explicit values if you want a runaway safety net. Engine change
   in `packages/core/src/exploratory/worker.ts` removes the magic
   defaults.
2. **Depth cap** — defer (SP3). Initially fine to rely on agents
   detecting their own loops via session history. Long-term direction
   is a queue + agent-side loop detection, not a hard cap.
3. **Goal-rotation vs sweep** — neither. Agent decides per tick "given
   my goals and recent activity, what is the most useful single thing
   to do now?" Same as existing exploratory tick prompt.
4. **Reactive vs online behaviour** — same agent definition for both.
   `goals.md` rule: during chat, prefer answering and proposing; defer
   initiating heavy work unless the user explicitly asks.
5. **Discoverability** — list specialists + when to use them in
   supervisor's `instructions:` block. Promote to a `list_agents` tool
   only if the list grows / churns.
6. **Three delegation forms** (target shape, partially deferred):
   - A — **sync delegate** (existing `delegate` tool).
   - B — **async delegate with inbox** — A calls B, gets a
     `correlation_id`, keeps working; B's response lands in A's inbox
     when ready; A polls or auto-reads on next tick. New
     `agent_messages` table + `inbox` tool. Tracked under SP4.
   - C — **async handoff (no response)** — `delegate(async: true)` with
     no `reply_to`, OR `tasks(action="create", assignee=…)` for
     work that deserves backlog accounting. Both viable; supervisor
     picks based on whether the work has a user-visible deliverable.

## Open items (post-SP1/SP2)

- Once SP4 lands, decide whether inbox messages should auto-inject into
  the tick prompt the way recall does, or always require explicit
  `inbox(action="poll")`. Lean toward auto-inject for reliability.
- Once a second supervisor goal lands beyond email, decide if
  per-specialist memory tagging is needed to keep recall noise down.
- Long-term: agent-side loop detection ("I already asked X about this,
  they said Y — skip the re-delegate") wants explicit goals.md guidance
  + perhaps a `recall.query` pattern aimed at "what have I delegated
  recently about this topic."
