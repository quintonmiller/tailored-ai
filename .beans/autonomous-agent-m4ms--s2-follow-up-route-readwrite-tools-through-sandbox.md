---
# autonomous-agent-m4ms
title: 'S2 follow-up: route read/write tools through sandbox'
status: todo
type: task
priority: normal
created_at: 2026-05-03T22:59:31Z
updated_at: 2026-05-03T22:59:31Z
parent: autonomous-agent-objy
---

Currently only exec.ts honors context.sandbox/sandboxHandle. Update read.ts and write.ts to call sandbox.readFile/writeFile when both are set. Without this, the docker sandbox can run commands isolated but file edits land on the host — confusing semantics. Should be a small, mechanical change once the sandbox is plumbed.
