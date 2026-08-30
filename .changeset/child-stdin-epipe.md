---
"@tailored-ai/core": patch
---

A hook script that ignores its input can no longer take the runtime down.

Writing to a child's stdin when the child has already exited raises `EPIPE`,
and an `EPIPE` on a stream with no `error` listener is an **uncaught
exception** — it does not reject the surrounding promise, it kills the process.
So a hook program that exits without reading its payload, which is a completely
ordinary hook, could fault the agent that ran it (#606).

This was not theoretical. It shows up as an intermittent failure of the core
test suite — roughly one run in two on a loaded machine, `Vitest caught 1
unhandled error`, always from `claude-hooks.ts` — which is the mild version of
the same race. In a deployment it kills the agent instead.

`closeChildStdin` in `shell.ts` now owns the operation. It attaches an error
listener before writing, stays silent on `EPIPE` and `ERR_STREAM_DESTROYED`
(the expected shapes of "the child is already gone"), logs anything else once,
and never throws.

**The child's exit code survives.** A hook that runs, ignores stdin and exits 2
has refused the tool call; losing that verdict to a plumbing error on the input
pipe would be a worse bug than the crash. The `close` handler resolves exactly
as before.

Applied at all four sites that close a child's stdin, not just the one observed
failing — `plugins/claude-hooks.ts`, `sandboxes/host.ts`,
`sandboxes/container.ts` and `tools/exec.ts`. The other three pass no payload so
their window is far narrower, but the operation is identical and none of them
had a listener either.
