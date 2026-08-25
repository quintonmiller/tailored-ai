---
"@tailored-ai/core": patch
---

Benchmark: record a run, replay it without a model.

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

A recording also carries the **witnesses** that run minted, in a header line
ahead of the calls. Scenarios mint fresh unguessable values every run on purpose
and substitute them into the prompt, so a replay that minted its own would ask a
different question and miss every fixture it owned — sixteen of the twenty
scenario files declare witnesses. Reusing them gives up nothing: a witness is
fresh so a *live* model cannot satisfy a check with a value it never read, and
under replay there is no model. Live runs still mint cryptographically.

That one is worth stating because no unit test could have found it. A fake
upstream answers whatever it is asked, so record and replay agree regardless of
what is in the prompt; it took a run against a real model, where the single
scenario using a witness missed on every request while the other four replayed
perfectly — and the score was unchanged, because that scenario was failing
anyway.

A run's record/replay state belongs to the **run**, not to the provider, for the
same reason: a run does not build one provider. `reload()` rebuilds it mid-turn,
and the `admin` tool triggers a reload — so a turn whose first response calls
`admin` builds two. With the state on the provider, both halves were wrong.
Recording truncated the file on the rebuild and threw away every call so far,
including the one whose response *caused* the reload, so on replay the run's
first request was the one request missing from its own recording. Replay built a
fresh reader whose place in the recording restarted at zero, so a request the
run made twice was answered with the first recorded response both times — not an
error, just a quietly wrong replay. `openRun` now decides both once, before the
run starts.

Recordings are keyed by seed as well as scenario, so `--repeats 3` records three
files instead of having each repeat truncate the last. `chatStream` is
deliberately absent — callers fall back to `chat()`, and a recorded stream would
differ only in chunk boundaries nothing asserts on.

Separately, the config catalog now reports read counts as buckets rather than
exact numbers. An exact count moved whenever any unrelated file happened to
mention a common word like `path` or `model`, which made the freshness gate fire
on work that had nothing to do with config — training people to regenerate
without reading. Zero, the only value that is a finding, is still exact.
