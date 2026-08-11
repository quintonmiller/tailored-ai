---
"@tailored-ai/core": patch
---

The stall detector catches cycles, not just immediate repeats.

`runAgentLoop` compared each round's tool calls to the round before it, so it
saw one shape of loop — the same call three times running — and missed
`A → B → A → B`, which reset the counter every round and ran to `maxToolRounds`
instead.

That is the more common shape. One benchmark scenario produced both in a single
batch: one run looped on a single call with an invented id and was caught,
another alternated two tools six times and was not.

`detectCycle` now examines the tail of the round history for a repeating block
of period 1-3, and `LoopStop { kind: "repeated-calls", period }` says which it
found. A period-1 cycle still needs three repetitions; longer cycles need two,
because a period-3 cycle repeated three times is nine rounds and most
deployments cap below that.

Round signatures still combine the calls with their results, so polling that
repeats its calls while its answers move is not a stall.
