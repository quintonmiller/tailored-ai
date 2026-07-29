---
"@tailored-ai/core": patch
---

Add a verification gate to the autonomous task loop. New built-in
`builtin:verify-gate` plugin (off by default) subscribes to `task.transitioned`
and bounces any task that reaches `done` without a recorded `VERIFY: PASS`
verdict back to the review stage, escalating to a human after `maxBounces`
rounds. Scope it to tagged work via `requireTags` (e.g. `["kind:code",
"kind:config"]`) so plain assistant tasks still self-close. Route the bounce
per task kind with `reviewerByTag` (e.g. `{ "kind:config": "verifier",
"kind:code": "reviewer" }`) so a config / live-surface task can go to a
non-worktree verifier (which curls the running instance) while code goes to the
worktree reviewer — the verifier isn't blocked by the project-path guard. The autopilot worker
now emits `task.transitioned` when it force-finalizes a task so the gate sees
the autopilot path the same as an agent-driven close. This closes the
"marked done without proof" hole — an implementer or the finalizer can no
longer assert completion without the reviewer actually running the change's
acceptance check.
