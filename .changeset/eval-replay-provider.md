---
"@tailored-ai/core": patch
---

The benchmark can record a run and replay it without a model.

`pnpm run eval -- --record <dir>` writes every model call to
`<dir>/<scenario-id>-seed<n>.jsonl` as it happens; `--replay <dir>` answers from
those files and never opens a socket. The wrapper sits on the provider seam, so
the loop, tools, compaction and prompt assembly run exactly as they do live and
none of them know.

Three problems shared one cause — every run needed a live model.

- A run against an unreachable backend finishes in minutes with a zero and no
  error. `Recorder.failures` exists because a run against a server that accepted
  and never replied once scored 100% on prompt assertions. Under replay there is
  no endpoint to be down.
- Run-to-run swing on identical code is real, so a change worth a point or two
  cannot be seen by re-running. Replay is deterministic: same code, same
  transcript.
- CI could not run any of it.

Two deliberate rules. A **missing recording is an error, never a live call** —
falling through is how a "replay" run quietly stops being deterministic and
starts costing money. And a **changed request is a miss**, with a message naming
the request and the last message in it: requests match on a hash over model,
messages, tools, sampling and media references, so a prompt edit invalidates its
fixtures. That is the correct answer rather than an inconvenience, because the
model would have been asked something different and a recording cannot say what
it would have replied.

Recordings are keyed by seed as well as scenario, so `--repeats 3` records three
files instead of having each repeat truncate the last. `chatStream` is
deliberately absent — callers fall back to `chat()`, and a recorded stream would
differ only in chunk boundaries nothing asserts on.

Separately, the config catalog now reports read counts as buckets rather than
exact numbers. An exact count moved whenever any unrelated file happened to
mention a common word like `path` or `model`, which made the freshness gate fire
on work that had nothing to do with config — training people to regenerate
without reading. Zero, the only value that is a finding, is still exact.
