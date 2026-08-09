---
"@tailored-ai/core": patch
---

Stop the truncation marker telling agents to read a copy that returns the same cut.

When a tool result is capped, the marker ended "To see more, narrow the request —
fewer results, a filter, a smaller page size, or read the file above." Agents take
that advice, at roughly two reads of the saved copy per run, and it could never
have worked: `capToolOutput` is applied to every tool result, so reading the saved
file is capped by the same function at the same limit on the same input and comes
back byte-identical, elision included. `read` has no offset to page past the cut.

The sentence is now accurate — repeating the call *or* reading the saved copy
returns the same result — at the same length. The saved path is still named,
because that is how a person retrieves the full output.

Measured rather than assumed: at 15 runs per arm the pass rate on
`notices-a-truncated-tool-result` was 3/15 either way, and the reads of the saved
copy did not drop. This lands because the old sentence was false, not because it
moved a number; a longer version spelling out the consequence was tried in the
same experiment, measured nothing, and was dropped.
