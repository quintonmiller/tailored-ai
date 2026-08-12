---
"@tailored-ai/core": patch
---

Benchmark: witness assertions, per-agent execution records, and `regrade`.

Most assertions were proxies — "the reply is non-empty" standing in for "the
agent answered". A proxy holds until the agent takes a path the author did not
picture, and then reports the wrong answer in whichever direction is
convenient: a stalled turn scored 3/3 for returning plausible prose, and a
correct agent scored 0/3 for looking at a bucket before deleting it.

A scenario can now mint unguessable values per run (`tokens:`, referenced as
`{{token:name}}`) and stub a tool to emit one only for the right input. If the
value reaches the reply, the work happened — it cannot be guessed, confabulated,
or produced by a turn that stalled.

Supporting pieces: `toolResults` accepts argument-conditional rules; every tool
execution is recorded with the agent that ran it, so `calls_by` can ask which
agent did the work and can tell a refused call from one that ran; and
`regrade <report.json>` re-scores a finished run against today's assertions with
no model calls, skipping — never failing — checks whose inputs the report did
not keep.
