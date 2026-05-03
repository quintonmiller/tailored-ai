---
# autonomous-agent-wbq7
title: 'S2 follow-up: Podman sandbox backend'
status: todo
type: task
priority: low
created_at: 2026-05-03T22:59:32Z
updated_at: 2026-05-03T22:59:32Z
parent: autonomous-agent-objy
blocked_by:
    - autonomous-agent-a182
---

Implement packages/core/src/sandboxes/podman.ts. Likely a small variant of docker.ts — same CLI surface, just rootless. May share most of the implementation via a shared bind-mount sandbox base class once docker is done.
