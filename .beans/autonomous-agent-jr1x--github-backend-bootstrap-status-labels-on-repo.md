---
# autonomous-agent-jr1x
title: 'GitHub backend: bootstrap status:* labels on repo'
status: completed
type: task
priority: normal
tags:
    - github-backend
created_at: 2026-05-04T00:14:43Z
updated_at: 2026-05-04T00:46:50Z
parent: autonomous-agent-6p6y
---

First-run UX: when configured with the github backend, ensure status:backlog, status:in_progress, status:blocked, status:in_review labels exist on the repo with sensible colors. Today update() will create them implicitly with default coloring, which produces transient mismatches.

Add a bootstrap() method on GitHubTaskBackend that creates the labels if missing (idempotent). Call from createTaskBackend or on first autopilot tick. Should also create a reason:budget label at minimum.

Related to autonomous-agent-cv2p (T2 GitHub backend, completed).
