---
# autonomous-agent-q4r1
title: HO1 — stuck-tick detector in ExploratoryWorker
status: backlog
type: task
priority: high
created_at: 2026-05-19T04:27:37Z
updated_at: 2026-05-19T04:27:37Z
---

# HO1 — stuck-tick detector in ExploratoryWorker

On 2026-05-19 the supervisor (`default`) burned ~4 hours and ~1.1M
tokens across five consecutive ticks, each grinding to `maxToolRounds`
(20) on the same broken pattern: `read` calls against a hallucinated
repo path `~/repos/tai/...` returning `ENOENT`/`EISDIR`. Every tick was
classified `noop` (no notes / facts / tasks touched) because the agent
never produced a successful output before running out of rounds.

The existing repeat-call guard (`packages/core/src/agent/loop.ts`, the
`(callSig, resultSig)` detector from Fix A) only catches *identical*
calls with *identical* results. It doesn't catch this case — every
`read` was a different path that happened to return a different error
flavour.

## What to detect

A tick is "stuck" when the agent is consuming rounds without making
forward progress. Signal: high error rate from the *same tool* in a
short window. Concretely:

- Track per-tool error counts within the current tick.
- If a single tool errors `>= 3` times in a row (consecutive, not
  cumulative across the tick — interleaved successes should reset),
  abort the tick.
- On abort, write a single structured recall note tagged
  `[stuck-tick, <tool-name>]` summarising what was tried and what
  errored, then return.

## Where it goes

In the `ExploratoryWorker` per-tick loop, between rounds — not inside
the generic loop, because this rule is exploratory-tick-specific
(interactive sessions can legitimately retry the same broken read
while the user clarifies).

Likely shape: pass a small `ToolErrorBudget` collector into the loop's
`onToolResult` hook (or extend `AgentLoopOptions` with an
`abortPredicate(history): { stop: true, reason }`). The worker passes
in a predicate that inspects `history.slice(-6)` for the consecutive-
errors condition.

## Acceptance

- New test in `packages/core/src/__tests__/exploratory-worker.test.ts`:
  simulate a tool that returns `{ success: false }` three times in a
  row and verify the tick ends with status `noop` (or a new
  `stuck` status) and emits a recall note tagged `stuck-tick`.
- Counterexample test: alternating success/error stays alive.
- Round budget unchanged on normal ticks.

## Out of scope

- Catching slow / wasteful ticks that *succeed* (token budget bean).
- Making the agent self-recover. This bean just stops the bleed; the
  goals.md "three errors = stop" rule is the in-prompt counterpart.
