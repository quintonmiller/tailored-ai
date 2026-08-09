---
"@tailored-ai/core": patch
---

Answer instead of returning a marker when a turn runs out of tool rounds

A turn that spent `maxToolRounds` exited straight from the tool phase and
returned `[Agent stopped: max tool rounds reached]`, discarding the work it had
done. Measured on the benchmark's truncation scenario, 11 of 15 runs ended that
way — and in each one the agent had already read the file, seen where it was
cut, and tried three ways round it.

The loop now makes one more call with the tools withheld and returns what the
model says. Withholding is the mechanism: "stop calling tools and answer" is an
instruction a model can decline, and a model that has spent every round reaching
for a tool is the one that will. One extra request, only on the path that was
going to return nothing; the marker still stands when the model says nothing,
when the call fails, or when the caller has already aborted.

Callers that detected a stall by matching the reply must move to `onStop` —
`isStallStop(stop)`, or the new `stallReasonOf(stop)`. A stalled turn now
usually returns ordinary prose. `detectStall(reply)` stays exported but is wrong
in both directions: blind to a stall that answered, and it reports an operator
cancelling a dispatch as one. The task watcher now reads the structured stop,
which also stops it retrying cancelled dispatches.
