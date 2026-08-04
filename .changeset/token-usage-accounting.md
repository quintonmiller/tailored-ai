---
"@tailored-ai/core": patch
"@tailored-ai/server": patch
---

Token usage is recorded for every provider call, not just autopilot and exploratory.

Recording lived in two callers, so `token_usage` was a ledger of those two
subsystems and nothing else. Everything the loop actually runs day to day —
chat, room wakes, cron, delegation — recorded nothing. On a live deployment that
left the majority of traffic invisible: one agent ran 799 room messages in a
fortnight and contributed not a single row, which makes "what is this costing
me" unanswerable exactly where the answer matters.

The loop now writes one row per provider call, before invoking the caller's
`onUsage` so a throwing consumer cannot cost the accounting. Rows carry `agent`
and `source` (`loop` | `autopilot` | `exploratory`), and the two workers pass
their own label instead of recording themselves.

Widening the table must not widen the autopilot budget, or a busy hour in the
rooms would pause autopilot for reasons unrelated to autopilot. `checkBudget`
and `/api/autopilot/usage` are therefore scoped to `BUDGETED_TOKEN_SOURCES`
(autopilot + exploratory), which preserves what the caps meant before. Rows
predating the column have a NULL source and still count, since that is what they
were; a direct `recordTokenUsage` call that omits the source also stores NULL,
so an external caller does not silently drop out of the budget.

New `GET /api/usage?hours=` returns deployment-wide totals grouped by source and
by agent.
