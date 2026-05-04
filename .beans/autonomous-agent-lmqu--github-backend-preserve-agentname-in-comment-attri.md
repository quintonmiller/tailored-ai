---
# autonomous-agent-lmqu
title: 'GitHub backend: preserve agentName in comment attribution'
status: completed
type: task
priority: low
tags:
    - github-backend
created_at: 2026-05-04T00:14:43Z
updated_at: 2026-05-04T00:48:16Z
parent: autonomous-agent-6p6y
---

Comments via GH currently use the token user as author; the agent's agentName is dropped. Worth restoring: prepend [agentName] to the body when agentName is set AND distinct from the token user. Keep round-trip parsing in get() — strip a known-shape prefix on read so comment.author and comment.content end up clean.

Mentioned as a known limitation in the T2 commit. Related to autonomous-agent-cv2p.
