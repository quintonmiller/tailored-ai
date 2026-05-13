---
# autonomous-agent-a7g0
title: A3 — agent loop integration
status: completed
type: task
priority: high
created_at: 2026-05-13T07:52:09Z
updated_at: 2026-05-13T07:52:09Z
parent: autonomous-agent-gvue
---

ExploratoryWorker.runAgent() wires the agent loop in.

Flow per tick:
1. Build tick prompt: goals.md (from agent context dir + online.goals_file)
   + recent notes (listNotes filtered by agent) + pick-one-thing instruction.
2. Create xrun_<uuid> row.
3. Fresh session keyed exploratory:<agent>:<runId>; notes are durable memory.
4. runtime.buildLoopOptions(); override maxToolRounds with tool_calls_per_tick;
   if online.tools is set, narrow loop tools (and getTools) to that subset.
5. Run loop with per-tick AbortController; onUsage records token usage and
   aborts when tokens_per_tick is exceeded.
6. Complete xrun row with status (ok/error/budget), tokens_used, tool_calls,
   summary, error.
7. Update exploratory_state: stamp last_tick_at, last_tick_status, bump
   runs_today + tokens_today.

Defaults: tokens_per_tick=8000, tool_calls_per_tick=8. BudgetGuard provider
wrapper proper is deferred to A4 alongside idle backoff.

Worker exposes:
- runLoop option for test injection (no real provider needed)
- onRunFinished callback for UI/tests
- getActivity() reflecting current agent + runId during execution
- ToolContext gains exploratoryRunId for tools that want to attribute writes

Tests: 10 new (creates xrun, error path, token increments, budget abort,
tool narrowing, maxToolRounds override, prompt assembly, error xrun row,
onRunFinished, getActivity transitions). 878 core tests pass; typecheck clean.

A4: idle backoff + output detection (notes/facts/tasks created during the
run) for backoff reset on activity.
