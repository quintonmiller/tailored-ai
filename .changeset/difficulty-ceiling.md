---
"@tailored-ai/core": patch
---

Benchmark: extend the difficulty scale to 7 levels, and stop witness values from
colliding with each other.

The scale ran to five until the top of it stopped being the top. On the
2026-08-12 cohort level 5 scored 83% and level 4 scored 69% — the hardest tier
was easier than the one below it, and seven of the ten level-5 scenarios passed
every run. A scale whose last rung is cleared has no ceiling in view: it can
report that things are fine and cannot report where they stop, which is the one
question the benchmark exists to answer. 90% at the top is the same message as
100%, said more quietly.

The fix is not to relabel the rows that pass — that is the circularity the scale
was written to avoid. Levels 6 (`compound`) and 7 (`misleading`) name kinds of
demand the first five never described, with fifteen scenarios against 5-7 in
`scenarios/16-ceiling.yaml`.

Those two were still guesses, and level 7 came out at 87%. Levels 8-10 stop
guessing and stack instead: each is the one demand the set has measured this
model failing — a fact evicted from the history window comes back invented —
plus one more independent thing that must go right. One scenario each, in
`scenarios/17-limit.yaml`. They score 0%, 0% and 17% at six repeats, so the
scale finally has a bottom: the model will not say "I no longer have that", and
at level 9 it invents a threshold and schedules work against the comparison.

Separately, and independent of the scale: `mintTokens` now guarantees that no
witness value in a run contains another. Distinctness was not enough, because
every reply assertion is a substring match — `3rd` is a substring of `23rd`, and
a scenario asserting "mentions the new date, not the withdrawn one" failed an
agent that answered correctly. Fourteen of the 756 ordered day-pairs are
containments, so this fired on roughly 2% of runs of any scenario carrying two
of them, always in the direction that invents a capability gap. It also made the
discrimination suite fail on a healthy scenario about one run in eight.
