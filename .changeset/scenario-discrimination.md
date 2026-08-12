---
"@tailored-ai/core": patch
---

Benchmark: scenarios are now checked for whether their assertions can fail, and
a stalled turn no longer counts as a reply.

`replies: true` was `reply.trim().length > 0`, which accepted
`[Agent stopped: …]` — and accepted the more common case too, where a turn that
ran out of rounds returns ordinary prose with no marker at all. The eval harness
now records the structured `LoopStop` and `replies` consults it, so a stall
fails on either setting: `replies: false` asserts the agent *chose* not to
speak, which a turn that went in circles did not.

New `scenario-discrimination.test.ts` replays every scenario's assertions
against outcomes that are known bad — said nothing, returned a stop marker — and
fails any scenario that accepts one. It found 16 of 79. Fifteen were the
`replies` bug; the sixteenth was prohibition-only and now declares its expected
silence.
