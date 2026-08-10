---
"@tailored-ai/core": patch
---

Benchmark scenarios carry a difficulty, and the report is scored by it.

Every scenario declares `difficulty: 1-5` — reflex, routine, composed,
conflicting, frontier — graded on what the turn demands of the model, never on
what it currently scores. `--difficulty 4`, `4+`, `2-3` or `3,5` runs a slice,
and composes with `--filter`.

The overall score averages a regression tripwire against a scenario written to
find the ceiling, so it moves for the wrong reasons and cannot say where the
wall is. The rollup by level can, and running one level is what makes the
find-the-ceiling loop affordable: a full cohort is ~23 minutes of GPU, most of
it re-confirming rows that have passed every time for a month.

The level is an annotation, excluded from the scenario digest and fingerprints
like `intent` and `knownGap`, so re-grading costs no re-baseline.

Also adds `posts_by: {agent, matches}`. On a room scenario `reply` is every post
joined, so `reply_matches` passes when *either* agent produced the text — which
makes the multi-agent handoff question ("did the second agent use what the first
one found") true by construction the moment the first agent speaks. Without a
per-agent read, that class of scenario cannot be graded at all.
