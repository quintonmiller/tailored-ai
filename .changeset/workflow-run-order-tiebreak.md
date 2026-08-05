---
"@tailored-ai/core": patch
---

Give `listWorkflowRuns` a deterministic order for runs that tie.

`started_at` is `datetime('now')` — second resolution — and the query
ordered by it alone, so runs started in the same second tied and SQLite
returned them in whatever order it liked. Anything asking for "the N
newest" got an arbitrary N: `pruneOldRuns` deleted the log directory of a
run it should have kept, and a fanned-out workflow listed its runs
scrambled.

Ordering now falls back to `rowid`, which is monotonic with insert order
— the only meaning "newest" can have inside one second.

This is also the likely cause of the intermittent `pruneOldRuns` test
failure. That test had been avoiding the tie by sleeping 1.1s between
runs, which spent 2.2s of wall clock on a correctness argument that
depended on the suite not being under load; it now sets the timestamps
explicitly instead. A second test pins the tie case directly: it fails
against the old ordering and passes against the new one.
