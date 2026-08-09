---
"@tailored-ai/core": patch
---

Make the omitted middle of a truncated tool result reachable

`capToolOutput` cuts middle-out and saves the full output, and the saved copy
was a dead end: truncation is deterministic and `read` took only a path, so
reading it ran through the same function, at the same limit, on the same bytes,
and came back byte-identical. The elided middle had no route back at all short
of `exec` with `sed`.

`read` now takes `offset` and `limit` in characters, serves a window that fits
the budget, and names the exact call that continues it. Characters rather than
lines because that is the unit the cap counts in; line ranges stay `exec`'s job.

`ToolContext.maxOutputChars` carries the resolved per-tool budget into
`execute`, so any tool that can page may serve a prefix that fits instead of
being cut afterwards. Advisory — the cap still runs on whatever comes back.

The truncation marker now points at the saved file with the offset that resumes
it. That sentence was removed a release ago for being false; it is back because
the code that would make it true has landed.
