---
# autonomous-agent-q4r3
title: HO3 — surface failed delegations to the caller
status: backlog
type: task
priority: normal
created_at: 2026-05-19T05:15:00Z
updated_at: 2026-05-19T05:15:00Z
---

# HO3 — surface failed delegations to the caller

On 2026-05-19 the supervisor sync-delegated research to `researcher`,
which hit `maxToolRounds` and returned the bare string
`[Agent stopped: max tool rounds reached]`. The supervisor treated
this as a successful delegation, wrote a recall note saying
"research delegated... breaking into sub-tasks next" and proceeded
to create a self-assigned implementation sub-task — exactly the
busy-work cascade we're trying to prevent.

The model can't reliably notice this kind of failure mode from the
text alone. The framework should surface it.

## Fix direction

In `packages/core/src/tools/delegate.ts` (or wherever the sync
delegate path packages the sub-agent's final output), inspect the
sub-agent's loop result *before* returning it to the caller:

- If the sub-agent ended with `stoppedReason === "max_tool_rounds"`
  or any non-`done` terminal state, mark the tool result with
  `success: false` and an `error` field naming the failure mode.
- If the sub-agent's final assistant content is empty/whitespace
  AND no notes/tasks/etc were produced, same treatment.
- The output string the caller sees should lead with a clear
  prefix like `[delegate failed: max_tool_rounds]` so even if the
  caller doesn't check `success`, the text is unambiguous.

Async delegate is a different question — that path returns a
task id, and the failure surfaces via `task_status`. Out of scope
here (a sister bean if it turns out to mis-classify too).

## Acceptance

- New test in `packages/core/src/__tests__/delegate-tool.test.ts`
  that simulates a sub-agent hitting max rounds and asserts the
  parent's `ToolResult.success === false` with a recognisable
  error message.
- Counterexample test: a normal sub-agent completion returns
  `success: true` with the body unchanged.
- No regression on the existing delegate tests.

## Out of scope

- Auto-retry of failed delegations — the caller decides what to
  do.
- Stuck-tick detection (covered by HO1, autonomous-agent-q4r1).
- vLLM 400 fix (covered by HO2, autonomous-agent-q4r2).
